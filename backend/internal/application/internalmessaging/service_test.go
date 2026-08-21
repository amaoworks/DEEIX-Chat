package internalmessaging

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"

	domainmessaging "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/internalmessaging"
	domainuser "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/user"
	vocechat "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/integration/vocechat"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
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
	mu     sync.Mutex
	logins int
	sentTo int64
	sent   string
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
