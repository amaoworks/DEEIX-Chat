package internalmessaging

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	domain "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/internalmessaging"
	domainuser "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/user"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	repo "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/postgres/internalmessaging"
	voce "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/vocechat"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

type failingIndexStore struct {
	*repo.Repo
	failIndex  bool
	failIntent bool
}

func (s *failingIndexStore) RecordMessage(ctx context.Context, message domain.MessageIndex) (bool, error) {
	if s.failIndex {
		return false, errors.New("injected index failure")
	}
	return s.Repo.RecordMessage(ctx, message)
}
func (s *failingIndexStore) BeginIndexRepair(ctx context.Context, actor, peer uint, ready time.Time) (uint, error) {
	if s.failIntent {
		return 0, errors.New("injected intent failure")
	}
	return s.Repo.BeginIndexRepair(ctx, actor, peer, ready)
}

func repairFixture(t *testing.T) (*failingIndexStore, fakeUsers, *fakeVoce) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:repair-%d?mode=memory&cache=shared", time.Now().UnixNano())), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.AutoMigrate(&model.InternalMessagingBinding{}, &model.InternalMessagingMessage{}, &model.InternalMessagingConversation{}, &model.InternalMessagingIndexRepair{}); err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })
	users := fakeUsers{items: map[uint]domainuser.User{
		1: {ID: 1, PublicID: "actor", Username: "actor", Status: domainuser.StatusActive},
		2: {ID: 2, PublicID: "target", Username: "target", Status: domainuser.StatusActive},
	}}
	return &failingIndexStore{Repo: repo.NewRepo(db)}, users, &fakeVoce{}
}

func repairMessage(mid int64) voce.Message {
	message := voce.Message{MID: mid, FromUID: 1}
	message.Target.UID = 2
	message.Detail.Type, message.Detail.ContentType, message.Detail.Content = "normal", "text/plain", "delivered"
	return message
}

func TestIndexFailureSurvivesRestartAndRepairsWithoutResending(t *testing.T) {
	store, users, upstream := repairFixture(t)
	store.failIndex = true
	service := NewService(true, users, store, upstream)
	ctx := context.Background()
	message, err := service.Send(ctx, 1, "target", "delivered")
	if err != nil || message.ID != 7 {
		t.Fatalf("remote success must remain success: %+v %v", message, err)
	}
	if service.indexFailures.Load() != 1 {
		t.Fatal("index failure was not counted")
	}
	items, err := store.ListIndexRepairs(ctx, time.Now().Add(3*time.Minute), 10)
	if err != nil || len(items) != 1 {
		t.Fatalf("durable repair missing: %v %v", items, err)
	}
	if ready, _ := store.ListIndexRepairs(ctx, time.Now(), 10); len(ready) != 0 {
		t.Fatal("repair raced an in-flight remote request")
	}
	store.failIndex = false
	upstream.history = []voce.Message{repairMessage(7)}
	upstream.sent = "sentinel: recovery must not send"
	restarted := NewService(true, users, store, upstream)
	if err = restarted.repairIndex(ctx, store, items[0]); err != nil {
		t.Fatal(err)
	}
	if err = restarted.repairIndex(ctx, store, items[0]); err != nil {
		t.Fatal(err)
	}
	if upstream.sent != "sentinel: recovery must not send" {
		t.Fatal("recovery resent a message")
	}
	if pending, _ := store.PendingIndexRepairs(ctx); pending != 0 {
		t.Fatalf("pending=%d", pending)
	}
	if unread, _ := store.TotalUnread(ctx, 2); unread != 1 {
		t.Fatalf("duplicate unread after repair: %d", unread)
	}
	if found, err := store.FindMessage(ctx, 2, 7); err != nil || found.Content != "delivered" {
		t.Fatalf("missing repaired message: %v %v", found, err)
	}
}

func TestFailedRecoveryIntentPreventsRemoteSend(t *testing.T) {
	store, users, upstream := repairFixture(t)
	store.failIntent = true
	_, err := NewService(true, users, store, upstream).Send(context.Background(), 1, "target", "must not send")
	if err == nil || upstream.sent != "" {
		t.Fatalf("send escaped failed durable intent: %v %q", err, upstream.sent)
	}
}

func TestRepairPaginationPersistsProgressAcrossWorkerRestarts(t *testing.T) {
	store, users, upstream := repairFixture(t)
	ctx := context.Background()
	_, err := store.BeginIndexRepair(ctx, 1, 2, time.Now().Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	upstream.historyPages = make(map[int64][]voce.Message)
	before := int64(0)
	for high := int64(1100); high > 0; high -= 100 {
		for mid := high; mid > high-100; mid-- {
			upstream.historyPages[before] = append(upstream.historyPages[before], repairMessage(mid))
		}
		before = high - 99
	}
	items, _ := store.ListIndexRepairs(ctx, time.Now(), 10)
	if err = NewService(true, users, store, upstream).repairIndex(ctx, store, items[0]); err != nil {
		t.Fatal(err)
	}
	items, _ = store.ListIndexRepairs(ctx, time.Now().Add(time.Minute), 10)
	if len(items) != 1 || items[0].BeforeMID != 101 {
		t.Fatalf("pagination progress lost: %+v", items)
	}
	if err = NewService(true, users, store, upstream).repairIndex(ctx, store, items[0]); err != nil {
		t.Fatal(err)
	}
	if pending, _ := store.PendingIndexRepairs(ctx); pending != 0 {
		t.Fatalf("pending=%d", pending)
	}
	if unread, _ := store.TotalUnread(ctx, 2); unread != 1100 {
		t.Fatalf("repaired unread=%d", unread)
	}
}

type countedUsers struct {
	fakeUsers
	gets, lists int
	filter      repository.UserListFilter
}

func (u *countedUsers) GetByID(ctx context.Context, id uint) (*domainuser.User, error) {
	u.gets++
	return u.fakeUsers.GetByID(ctx, id)
}
func (u *countedUsers) ListUsers(ctx context.Context, offset, limit int, filter repository.UserListFilter) ([]domainuser.User, int64, error) {
	u.lists++
	u.filter = filter
	return u.fakeUsers.ListUsers(ctx, offset, limit, filter)
}

func TestConversationDirectoryBatchesPeerLookup(t *testing.T) {
	store, users, upstream := repairFixture(t)
	ctx := context.Background()
	for id := uint(2); id <= 61; id++ {
		users.items[id] = domainuser.User{ID: id, PublicID: fmt.Sprint(id), Status: domainuser.StatusActive}
		if _, err := store.RecordMessage(ctx, domain.MessageIndex{MID: int64(id), SenderUserID: 1, RecipientUserID: id, Content: "hello", SentAt: time.Now()}); err != nil {
			t.Fatal(err)
		}
	}
	counted := &countedUsers{fakeUsers: users}
	service := NewService(true, counted, store, upstream)
	first, err := service.ListConversations(ctx, 1, 1, 50)
	if err != nil || len(first.Results) != 50 || !first.HasMore {
		t.Fatalf("first page: %d %v", len(first.Results), err)
	}
	if counted.gets != 1 || counted.lists != 1 || len(counted.filter.IDs) != 50 {
		t.Fatalf("not batched: %+v", counted)
	}
	second, err := service.ListConversations(ctx, 1, 2, 50)
	if err != nil || len(second.Results) != 10 || second.HasMore {
		t.Fatalf("second page: %d %v", len(second.Results), err)
	}
}

func TestRepeatedDeviceEventsShareIndexWorkAndDoNotCacheFailures(t *testing.T) {
	store, users, upstream := repairFixture(t)
	counted := &countedUsers{fakeUsers: users}
	service := NewService(true, counted, store, upstream)
	ctx := context.Background()
	if _, err := service.Send(ctx, 1, "target", "initial"); err != nil {
		t.Fatal(err)
	}
	raw := `{"type":"chat","mid":8,"from_uid":1,"target":{"uid":2},"detail":{"type":"normal","content_type":"text/plain","content":"event"}}`
	store.failIndex = true
	if _, err := service.ProcessEvent(ctx, raw); err == nil {
		t.Fatal("expected indexing failure")
	}
	store.failIndex = false
	counted.gets = 0
	var workers sync.WaitGroup
	for range 32 {
		workers.Go(func() {
			sender, err := service.ProcessEvent(ctx, raw)
			if err != nil || sender != "actor" {
				t.Errorf("sender=%q err=%v", sender, err)
			}
		})
	}
	workers.Wait()
	if counted.gets != 2 {
		t.Fatalf("duplicate lookup work: %d", counted.gets)
	}
	if unread, _ := store.TotalUnread(ctx, 2); unread != 2 {
		t.Fatalf("duplicate unread=%d", unread)
	}
}
