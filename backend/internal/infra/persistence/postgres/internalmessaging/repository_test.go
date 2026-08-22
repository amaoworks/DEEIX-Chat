package internalmessaging

import (
	"context"
	"fmt"
	"testing"
	"time"

	domainmessaging "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/internalmessaging"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newTestRepo(t *testing.T) *Repo {
	t.Helper()
	dsn := fmt.Sprintf("file:internal-messaging-%d?mode=memory&cache=shared", time.Now().UnixNano())
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.InternalMessagingMessage{}, &model.InternalMessagingConversation{}); err != nil {
		t.Fatal(err)
	}
	return NewRepo(db)
}

func TestRecordMessageMaintainsDurableUnreadAndRecentState(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	sentAt := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	message := domainmessaging.MessageIndex{
		MID: 10, SenderUserID: 1, RecipientUserID: 2,
		ContentType: "text/plain", Content: "hello recipient", SentAt: sentAt,
	}
	created, err := repo.RecordMessage(ctx, message)
	if err != nil || !created {
		t.Fatalf("first record: created=%t err=%v", created, err)
	}
	created, err = repo.RecordMessage(ctx, message)
	if err != nil || created {
		t.Fatalf("duplicate record: created=%t err=%v", created, err)
	}

	senderStates, _, senderUnread, err := repo.ListConversations(ctx, 1, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(senderStates) != 1 || senderUnread != 0 || senderStates[0].LastMessageMID != 10 {
		t.Fatalf("unexpected sender state: states=%+v unread=%d", senderStates, senderUnread)
	}
	recipientStates, _, recipientUnread, err := repo.ListConversations(ctx, 2, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(recipientStates) != 1 || recipientUnread != 1 || recipientStates[0].UnreadCount != 1 {
		t.Fatalf("unexpected recipient state: states=%+v unread=%d", recipientStates, recipientUnread)
	}

	if err := repo.MarkRead(ctx, 2, 1, 10); err != nil {
		t.Fatal(err)
	}
	if unread, err := repo.TotalUnread(ctx, 2); err != nil || unread != 0 {
		t.Fatalf("unread after mark read = %d, err=%v", unread, err)
	}
}

func TestMarkReadKeepsNewerMessagesUnreadAndClampsFutureMID(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	for _, mid := range []int64{31, 32} {
		if _, err := repo.RecordMessage(ctx, domainmessaging.MessageIndex{
			MID: mid, SenderUserID: 1, RecipientUserID: 2,
			ContentType: "text/plain", Content: "message", SentAt: time.Now().UTC(),
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := repo.MarkRead(ctx, 2, 1, 31); err != nil {
		t.Fatal(err)
	}
	states, _, unread, err := repo.ListConversations(ctx, 2, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(states) != 1 || states[0].ReadThroughMID != 31 || states[0].UnreadCount != 1 || unread != 1 {
		t.Fatalf("partial read state = %+v total unread=%d", states, unread)
	}

	if err := repo.MarkRead(ctx, 2, 1, 999999); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.RecordMessage(ctx, domainmessaging.MessageIndex{
		MID: 33, SenderUserID: 1, RecipientUserID: 2,
		ContentType: "text/plain", Content: "future message", SentAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	states, _, unread, err = repo.ListConversations(ctx, 2, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	if states[0].ReadThroughMID != 32 || states[0].UnreadCount != 1 || unread != 1 {
		t.Fatalf("future MID poisoned unread state: %+v total unread=%d", states[0], unread)
	}
}

func TestConversationPreferencesSurviveNewMessagesAndSearchIsScoped(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	pinned, muted := true, true
	if err := repo.SetConversationPreferences(ctx, 1, 2, &pinned, &muted); err != nil {
		t.Fatal(err)
	}
	for _, item := range []domainmessaging.MessageIndex{
		{MID: 11, SenderUserID: 1, RecipientUserID: 2, ContentType: "text/plain", Content: "first searchable message", SentAt: time.Now().UTC()},
		{MID: 12, SenderUserID: 3, RecipientUserID: 1, ContentType: "text/plain", Content: "other searchable message", SentAt: time.Now().UTC()},
	} {
		if _, err := repo.RecordMessage(ctx, item); err != nil {
			t.Fatal(err)
		}
	}
	states, _, _, err := repo.ListConversations(ctx, 1, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(states) != 2 || states[0].PeerUserID != 2 || !states[0].Pinned || !states[0].Muted {
		t.Fatalf("unexpected ordered states: %+v", states)
	}
	results, err := repo.SearchMessages(ctx, 1, 2, "searchable", 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].MID != 11 {
		t.Fatalf("unexpected scoped search: %+v", results)
	}
}

func TestFileQuotaAndDeleteKeepUnreadAndStorageConsistent(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	for _, item := range []domainmessaging.MessageIndex{
		{MID: 21, SenderUserID: 1, RecipientUserID: 2, ContentType: "vocechat/file", Content: "path-a", FileSize: 1024, SentAt: time.Now().UTC()},
		{MID: 22, SenderUserID: 1, RecipientUserID: 2, ContentType: "vocechat/file", Content: "path-b", FileSize: 2048, SentAt: time.Now().UTC()},
	} {
		if _, err := repo.RecordMessage(ctx, item); err != nil {
			t.Fatal(err)
		}
	}
	if bytes, err := repo.UserFileBytes(ctx, 1); err != nil || bytes != 3072 {
		t.Fatalf("file bytes = %d, err=%v", bytes, err)
	}
	if unread, err := repo.TotalUnread(ctx, 2); err != nil || unread != 2 {
		t.Fatalf("unread before delete = %d, err=%v", unread, err)
	}
	if err := repo.DeleteMessage(ctx, 1, 22); err != nil {
		t.Fatal(err)
	}
	if bytes, err := repo.UserFileBytes(ctx, 1); err != nil || bytes != 1024 {
		t.Fatalf("file bytes after delete = %d, err=%v", bytes, err)
	}
	if unread, err := repo.TotalUnread(ctx, 2); err != nil || unread != 1 {
		t.Fatalf("unread after delete = %d, err=%v", unread, err)
	}
	if err := repo.DeleteMessage(ctx, 1, 22); err != nil {
		t.Fatal(err)
	}
	if unread, _ := repo.TotalUnread(ctx, 2); unread != 1 {
		t.Fatalf("idempotent delete changed unread to %d", unread)
	}
	if count, bytes, err := repo.MessageStats(ctx); err != nil || count != 2 || bytes != 1024 {
		t.Fatalf("message stats after delete = count %d bytes %d, err=%v", count, bytes, err)
	}
}
