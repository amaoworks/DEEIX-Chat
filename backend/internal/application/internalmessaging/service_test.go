package internalmessaging

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	domainmessaging "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/internalmessaging"
	domainuser "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/user"
	vocechat "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/integration/vocechat"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	internalmessagingrepo "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/postgres/internalmessaging"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

type fakeUsers struct{ items map[uint]domainuser.User }

func (f fakeUsers) GetByID(_ context.Context, id uint) (*domainuser.User, error) {
	item, ok := f.items[id]
	if !ok {
		return nil, errors.New("not found")
	}
	return &item, nil
}
func (f fakeUsers) GetByPublicID(_ context.Context, publicID string) (*domainuser.User, error) {
	for _, item := range f.items {
		if item.PublicID == publicID {
			copy := item
			return &copy, nil
		}
	}
	return nil, errors.New("not found")
}
func (f fakeUsers) ListUsers(_ context.Context, offset, limit int, _ repository.UserListFilter) ([]domainuser.User, int64, error) {
	all := make([]domainuser.User, 0, len(f.items))
	for _, item := range f.items {
		all = append(all, item)
	}
	if offset >= len(all) {
		return nil, int64(len(all)), nil
	}
	end := offset + limit
	if end > len(all) {
		end = len(all)
	}
	return all[offset:end], int64(len(all)), nil
}

type recordingUsers struct {
	fakeUsers
	filter repository.UserListFilter
}

func (f *recordingUsers) ListUsers(ctx context.Context, offset, limit int, filter repository.UserListFilter) ([]domainuser.User, int64, error) {
	f.filter = filter
	return f.fakeUsers.ListUsers(ctx, offset, limit, filter)
}

type fakeBindings struct {
	mu    sync.Mutex
	items map[uint]domainmessaging.Binding
}

func (f *fakeBindings) Upsert(_ context.Context, item domainmessaging.Binding) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.items[item.UserID] = item
	return nil
}
func (f *fakeBindings) FindByUserID(_ context.Context, id uint) (*domainmessaging.Binding, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	item, ok := f.items[id]
	if !ok {
		return nil, errors.New("not found")
	}
	return &item, nil
}
func (f *fakeBindings) FindByVoceUID(_ context.Context, voceUID int64) (*domainmessaging.Binding, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, item := range f.items {
		if item.VoceUID == voceUID {
			copy := item
			return &copy, nil
		}
	}
	return nil, errors.New("not found")
}

type fakeVoce struct {
	mu         sync.Mutex
	logins     int
	sentTo     int64
	sent       string
	deletedMID int64
	deleteErr  error
}

func (f *fakeVoce) Healthy(context.Context) bool { return true }
func (f *fakeVoce) LoginAs(_ context.Context, publicID, _ string) (vocechat.Login, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logins++
	uid := int64(2)
	if publicID == "actor" {
		uid = 1
	}
	return vocechat.Login{Token: "token-" + publicID, User: vocechat.User{UID: uid}}, nil
}
func (f *fakeVoce) History(context.Context, string, int64, int64, int) ([]vocechat.Message, error) {
	return nil, nil
}
func (f *fakeVoce) Send(_ context.Context, _ string, uid int64, content string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sentTo, f.sent = uid, content
	return 7, nil
}
func (f *fakeVoce) Reply(context.Context, string, int64, string) (int64, error) { return 8, nil }
func (f *fakeVoce) Edit(context.Context, string, int64, string) (int64, error)  { return 9, nil }
func (f *fakeVoce) Delete(_ context.Context, _ string, mid int64) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deletedMID = mid
	return 10, f.deleteErr
}
func (f *fakeVoce) UploadFile(context.Context, string, string, string, []byte) (vocechat.UploadedFile, error) {
	return vocechat.UploadedFile{Path: "2026/8/21/file", Size: 4}, nil
}
func (f *fakeVoce) SendFile(context.Context, string, int64, string) (int64, error) {
	return 11, nil
}
func (f *fakeVoce) DownloadFile(context.Context, string, string, bool) (*http.Response, error) {
	return nil, errors.New("not used")
}
func (f *fakeVoce) UpdateName(context.Context, string, string) error { return nil }
func (f *fakeVoce) Events(context.Context, string, int64) (*http.Response, error) {
	return nil, errors.New("not used")
}

func TestSendProvisionsBothUsersAndUsesTargetVoceUID(t *testing.T) {
	users := fakeUsers{items: map[uint]domainuser.User{1: {ID: 1, PublicID: "actor", Username: "actor", Status: domainuser.StatusActive}, 2: {ID: 2, PublicID: "target", Username: "target", Status: domainuser.StatusActive}}}
	bindings := &fakeBindings{items: map[uint]domainmessaging.Binding{}}
	voce := &fakeVoce{}
	service := NewService(true, users, bindings, voce)

	message, err := service.Send(context.Background(), 1, "target", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if message.ID != 7 || message.FromUserPublicID != "actor" || voce.sentTo != 2 || voce.sent != "hello" {
		t.Fatalf("unexpected message=%+v target=%d content=%q", message, voce.sentTo, voce.sent)
	}
	if len(bindings.items) != 2 {
		t.Fatalf("bindings = %d, want 2", len(bindings.items))
	}
}

func TestSendRejectsInactiveRecipient(t *testing.T) {
	users := fakeUsers{items: map[uint]domainuser.User{1: {ID: 1, PublicID: "actor", Username: "actor", Status: domainuser.StatusActive}, 2: {ID: 2, PublicID: "target", Username: "target", Status: domainuser.StatusSuspended}}}
	service := NewService(true, users, &fakeBindings{items: map[uint]domainmessaging.Binding{}}, &fakeVoce{})
	_, err := service.Send(context.Background(), 1, "target", "hello")
	if !errors.Is(err, ErrRecipientUnavailable) {
		t.Fatalf("error = %v", err)
	}
}

func TestInitialProvisioningIsSerialized(t *testing.T) {
	users := fakeUsers{items: map[uint]domainuser.User{1: {ID: 1, PublicID: "actor", Username: "actor", Status: domainuser.StatusActive}}}
	bindings := &fakeBindings{items: map[uint]domainmessaging.Binding{}}
	service := NewService(true, users, bindings, &fakeVoce{})
	var group sync.WaitGroup
	for range 8 {
		group.Add(1)
		go func() {
			defer group.Done()
			if _, err := service.loginAndBind(context.Background(), users.items[1]); err != nil {
				t.Error(err)
			}
		}()
	}
	group.Wait()
	if len(bindings.items) != 1 {
		t.Fatalf("bindings = %d, want 1", len(bindings.items))
	}
}

func TestListUsersRequestsOnlyActiveUsersAndExcludesActor(t *testing.T) {
	users := &recordingUsers{fakeUsers: fakeUsers{items: map[uint]domainuser.User{
		1: {ID: 1, PublicID: "actor", Username: "actor", Status: domainuser.StatusActive},
		2: {ID: 2, PublicID: "target", Username: "target", Status: domainuser.StatusActive},
	}}}
	service := NewService(true, users, &fakeBindings{items: map[uint]domainmessaging.Binding{}}, &fakeVoce{})

	page, err := service.ListUsers(context.Background(), 1, "", 1, 30)
	if err != nil {
		t.Fatal(err)
	}
	if users.filter.Status != domainuser.StatusActive {
		t.Fatalf("status filter = %q", users.filter.Status)
	}
	if page.Total != 1 || len(page.Results) != 1 || page.Results[0].PublicID != "target" {
		t.Fatalf("unexpected page: %+v", page)
	}
}

func TestListUsersRejectsInactiveActor(t *testing.T) {
	users := fakeUsers{items: map[uint]domainuser.User{
		1: {ID: 1, PublicID: "actor", Username: "actor", Status: domainuser.StatusSuspended},
	}}
	service := NewService(true, users, &fakeBindings{items: map[uint]domainmessaging.Binding{}}, &fakeVoce{})

	_, err := service.ListUsers(context.Background(), 1, "", 1, 30)
	if !errors.Is(err, ErrRecipientUnavailable) {
		t.Fatalf("error = %v", err)
	}
}

func TestEventSenderPublicIDResolvesActiveDEEIXUser(t *testing.T) {
	users := fakeUsers{items: map[uint]domainuser.User{
		2: {ID: 2, PublicID: "sender", Username: "sender", Status: domainuser.StatusActive},
	}}
	bindings := &fakeBindings{items: map[uint]domainmessaging.Binding{
		2: {UserID: 2, UserPublicID: "sender", VoceUID: 42},
	}}
	service := NewService(true, users, bindings, &fakeVoce{})

	publicID, err := service.EventSenderPublicID(context.Background(), 42)
	if err != nil {
		t.Fatal(err)
	}
	if publicID != "sender" {
		t.Fatalf("public ID = %q, want sender", publicID)
	}
}

func TestEventSenderPublicIDRejectsInactiveDEEIXUser(t *testing.T) {
	users := fakeUsers{items: map[uint]domainuser.User{
		2: {ID: 2, PublicID: "sender", Username: "sender", Status: domainuser.StatusSuspended},
	}}
	bindings := &fakeBindings{items: map[uint]domainmessaging.Binding{
		2: {UserID: 2, UserPublicID: "sender", VoceUID: 42},
	}}
	service := NewService(true, users, bindings, &fakeVoce{})

	_, err := service.EventSenderPublicID(context.Background(), 42)
	if !errors.Is(err, ErrRecipientUnavailable) {
		t.Fatalf("error = %v", err)
	}
}

func TestVoceNameRespectsVoceChatLimitWithoutChangingDirectoryName(t *testing.T) {
	user := domainuser.User{DisplayName: "这是一个超过三十二个字符的 DEEIX 用户展示名称，需要在 VoceChat 中安全截断"}
	if got := len([]rune(voceName(user))); got != 32 {
		t.Fatalf("VoceChat name length = %d, want 32", got)
	}
	if displayName(user) != user.DisplayName {
		t.Fatal("directory name must preserve the DEEIX display name")
	}
}

func TestProcessEventAppliesEditAndDeleteReactionWithoutNewUnread(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:messaging-reaction-%d?mode=memory&cache=shared", time.Now().UnixNano())), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.AutoMigrate(&model.InternalMessagingBinding{}, &model.InternalMessagingMessage{}, &model.InternalMessagingConversation{}); err != nil {
		t.Fatal(err)
	}
	store := internalmessagingrepo.NewRepo(db)
	ctx := context.Background()
	for _, binding := range []domainmessaging.Binding{
		{UserID: 1, UserPublicID: "actor", VoceUID: 1, SyncedAt: time.Now()},
		{UserID: 2, UserPublicID: "target", VoceUID: 2, SyncedAt: time.Now()},
	} {
		if err = store.Upsert(ctx, binding); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = store.RecordMessage(ctx, domainmessaging.MessageIndex{MID: 10, SenderUserID: 1, RecipientUserID: 2, ContentType: "text/plain", Content: "before", SentAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	service := NewService(true, fakeUsers{items: map[uint]domainuser.User{
		1: {ID: 1, PublicID: "actor", Username: "actor", Status: domainuser.StatusActive},
		2: {ID: 2, PublicID: "target", Username: "target", Status: domainuser.StatusActive},
	}}, store, &fakeVoce{})

	edit := `{"type":"chat","mid":11,"from_uid":1,"target":{"uid":2},"detail":{"type":"reaction","mid":10,"detail":{"type":"edit","content_type":"text/plain","content":"after"}}}`
	if sender, processErr := service.ProcessEvent(ctx, edit); processErr != nil || sender != "actor" {
		t.Fatalf("sender=%q err=%v", sender, processErr)
	}
	item, err := store.FindMessage(ctx, 1, 10)
	if err != nil || item.Content != "after" || item.EditedAt.IsZero() {
		t.Fatalf("edited item=%+v err=%v", item, err)
	}
	if unread, _ := store.TotalUnread(ctx, 2); unread != 1 {
		t.Fatalf("edit reaction changed unread to %d", unread)
	}

	deleted := `{"type":"chat","mid":12,"from_uid":1,"target":{"uid":2},"detail":{"type":"reaction","mid":10,"detail":{"type":"delete"}}}`
	if _, err = service.ProcessEvent(ctx, deleted); err != nil {
		t.Fatal(err)
	}
	item, err = store.FindMessage(ctx, 2, 10)
	if err != nil || !item.Deleted {
		t.Fatalf("deleted item=%+v err=%v", item, err)
	}
	if unread, _ := store.TotalUnread(ctx, 2); unread != 0 {
		t.Fatalf("delete reaction left unread=%d", unread)
	}
}

func TestCleanupExpiredRetriesFailuresAndKeepsRecentMessages(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:messaging-retention-%d?mode=memory&cache=shared", time.Now().UnixNano())), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.AutoMigrate(&model.InternalMessagingBinding{}, &model.InternalMessagingMessage{}, &model.InternalMessagingConversation{}); err != nil {
		t.Fatal(err)
	}
	store := internalmessagingrepo.NewRepo(db)
	ctx := context.Background()
	for _, binding := range []domainmessaging.Binding{
		{UserID: 1, UserPublicID: "actor", VoceUID: 1, SyncedName: "actor", SyncedAt: time.Now()},
		{UserID: 2, UserPublicID: "target", VoceUID: 2, SyncedName: "target", SyncedAt: time.Now()},
	} {
		if err = store.Upsert(ctx, binding); err != nil {
			t.Fatal(err)
		}
	}
	for _, message := range []domainmessaging.MessageIndex{
		{MID: 41, SenderUserID: 1, RecipientUserID: 2, ContentType: "text/plain", Content: "expired", SentAt: time.Now().Add(-48 * time.Hour)},
		{MID: 42, SenderUserID: 1, RecipientUserID: 2, ContentType: "text/plain", Content: "recent", SentAt: time.Now()},
	} {
		if _, err = store.RecordMessage(ctx, message); err != nil {
			t.Fatal(err)
		}
	}
	voce := &fakeVoce{deleteErr: errors.New("temporary delete failure")}
	service := NewService(true, fakeUsers{items: map[uint]domainuser.User{
		1: {ID: 1, PublicID: "actor", Username: "actor", Status: domainuser.StatusActive},
		2: {ID: 2, PublicID: "target", Username: "target", Status: domainuser.StatusActive},
	}}, store, voce)
	service.SetPolicyProvider(func() Policy {
		return Policy{Enabled: true, MaxFileBytes: MaxFileBytes, RetentionDays: 1}
	})

	service.cleanupExpired(ctx)
	expired, err := store.FindMessage(ctx, 1, 41)
	if err != nil || expired.Deleted {
		t.Fatalf("failed retention delete must remain retryable: item=%+v err=%v", expired, err)
	}

	voce.mu.Lock()
	voce.deleteErr = nil
	voce.mu.Unlock()
	service.cleanupExpired(ctx)
	expired, err = store.FindMessage(ctx, 1, 41)
	if err != nil || !expired.Deleted {
		t.Fatalf("expired message was not deleted on retry: item=%+v err=%v", expired, err)
	}
	recent, err := store.FindMessage(ctx, 1, 42)
	if err != nil || recent.Deleted {
		t.Fatalf("recent message was deleted by retention: item=%+v err=%v", recent, err)
	}
	voce.mu.Lock()
	deletedMID := voce.deletedMID
	voce.mu.Unlock()
	if deletedMID != 41 {
		t.Fatalf("deleted MID = %d, want 41", deletedMID)
	}
}

func TestSendFileEnforcesSizeAndUserQuota(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:messaging-file-policy-%d?mode=memory&cache=shared", time.Now().UnixNano())), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.AutoMigrate(&model.InternalMessagingBinding{}, &model.InternalMessagingMessage{}, &model.InternalMessagingConversation{}); err != nil {
		t.Fatal(err)
	}
	store := internalmessagingrepo.NewRepo(db)
	ctx := context.Background()
	for _, binding := range []domainmessaging.Binding{
		{UserID: 1, UserPublicID: "actor", VoceUID: 1, SyncedName: "actor", SyncedAt: time.Now()},
		{UserID: 2, UserPublicID: "target", VoceUID: 2, SyncedName: "target", SyncedAt: time.Now()},
	} {
		if err = store.Upsert(ctx, binding); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = store.RecordMessage(ctx, domainmessaging.MessageIndex{
		MID: 51, SenderUserID: 1, RecipientUserID: 2, ContentType: "vocechat/file",
		Content: "existing/path", MetadataJSON: `{}`, FileSize: 4, SentAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	service := NewService(true, fakeUsers{items: map[uint]domainuser.User{
		1: {ID: 1, PublicID: "actor", Username: "actor", Status: domainuser.StatusActive},
		2: {ID: 2, PublicID: "target", Username: "target", Status: domainuser.StatusActive},
	}}, store, &fakeVoce{})
	service.SetPolicyProvider(func() Policy {
		return Policy{Enabled: true, MaxFileBytes: 10, UserQuotaBytes: 5}
	})

	if _, err = service.SendFile(ctx, 1, "target", "large.txt", "text/plain", []byte("01234567890")); !errors.Is(err, ErrFileTooLarge) {
		t.Fatalf("oversized file error = %v", err)
	}
	if _, err = service.SendFile(ctx, 1, "target", "quota.txt", "text/plain", []byte("12")); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("quota error = %v", err)
	}
}

func TestToMessagesDeduplicatesMIDUsingLatestMessage(t *testing.T) {
	first := vocechat.Message{MID: 321, FromUID: 1}
	first.Detail.Type = "normal"
	first.Detail.Content = "first"
	second := vocechat.Message{MID: 321, FromUID: 1}
	second.Detail.Type = "normal"
	second.Detail.Content = "latest"

	service := &Service{}
	items := service.toMessages(
		context.Background(),
		1,
		[]vocechat.Message{first, second},
		1,
		2,
		"actor",
		"target",
	)

	if len(items) != 1 {
		t.Fatalf("message count = %d, want 1", len(items))
	}
	if items[0].ID != 321 || items[0].Content != "latest" {
		t.Fatalf("message = %+v, want latest MID 321", items[0])
	}
}
