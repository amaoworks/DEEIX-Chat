package internalmessaging

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	domainmessaging "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/internalmessaging"
	domainuser "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/user"
	vocechat "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/integration/vocechat"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

var (
	ErrDisabled             = errors.New("internal messaging is disabled")
	ErrRecipientUnavailable = errors.New("recipient is unavailable")
)

type userStore interface {
	GetByID(context.Context, uint) (*domainuser.User, error)
	GetByPublicID(context.Context, string) (*domainuser.User, error)
	ListUsers(context.Context, int, int, repository.UserListFilter) ([]domainuser.User, int64, error)
}

type bindingStore interface {
	Upsert(context.Context, domainmessaging.Binding) error
	FindByUserID(context.Context, uint) (*domainmessaging.Binding, error)
	FindByVoceUID(context.Context, int64) (*domainmessaging.Binding, error)
}

type voceClient interface {
	Healthy(context.Context) bool
	LoginAs(context.Context, string, string) (vocechat.Login, error)
	History(context.Context, string, int64, int64, int) ([]vocechat.Message, error)
	Send(context.Context, string, int64, string) (int64, error)
	UpdateName(context.Context, string, string) error
	Events(context.Context, string, int64) (*http.Response, error)
}

type Service struct {
	enabled          bool
	users            userStore
	bindings         bindingStore
	voce             voceClient
	provisioningLock sync.Map // map[uint]*sync.Mutex; only used for first bind
}

type DirectoryUser struct{ PublicID, Username, DisplayName, AvatarURL string }
type Page struct {
	Total   int64
	Results []DirectoryUser
	HasMore bool
}
type ChatMessage struct {
	ID               int64
	FromUserPublicID string
	Content          string
	CreatedAt        string
}

func NewService(enabled bool, users userStore, bindings bindingStore, voce voceClient) *Service {
	return &Service{enabled: enabled, users: users, bindings: bindings, voce: voce}
}
func (s *Service) Enabled() bool { return s.enabled && s.voce != nil }

// Available performs a bounded private-network readiness check for UI entry
// decisions. Failed checks do not affect any other DEEIX feature.
func (s *Service) Available(ctx context.Context, actorID uint) bool {
	if !s.Enabled() || !s.voce.Healthy(ctx) {
		return false
	}
	actor, err := s.users.GetByID(ctx, actorID)
	if err != nil || actor == nil || !available(*actor) {
		return false
	}
	_, err = s.loginAndBind(ctx, *actor)
	return err == nil
}

func (s *Service) ListUsers(ctx context.Context, actorID uint, query string, page, pageSize int) (Page, error) {
	if !s.Enabled() {
		return Page{}, ErrDisabled
	}
	actor, err := s.users.GetByID(ctx, actorID)
	if err != nil || actor == nil || !available(*actor) {
		return Page{}, ErrRecipientUnavailable
	}
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 30
	}
	if pageSize > 100 {
		pageSize = 100
	}
	items, total, err := s.users.ListUsers(ctx, (page-1)*pageSize, pageSize, repository.UserListFilter{
		Query:  strings.TrimSpace(query),
		Status: domainuser.StatusActive,
	})
	if err != nil {
		return Page{}, err
	}
	results := make([]DirectoryUser, 0, len(items))
	for _, item := range items {
		if item.ID != actor.ID && item.Status == domainuser.StatusActive {
			results = append(results, toDirectoryUser(item))
		}
	}
	// The underlying shared directory includes the current user. Do not expose
	// it as a DM target and report a total consistent with the visible list.
	if total > 0 {
		total--
	}
	return Page{Total: total, Results: results, HasMore: int64(page*pageSize) < total+1}, nil
}

func (s *Service) History(ctx context.Context, actorID uint, recipientPublicID string, before int64) ([]ChatMessage, error) {
	actor, target, actorLogin, targetLogin, err := s.resolveChat(ctx, actorID, recipientPublicID)
	if err != nil {
		return nil, err
	}
	messages, err := s.voce.History(ctx, actorLogin.Token, targetLogin.User.UID, before, 50)
	if err != nil {
		return nil, err
	}
	return s.toMessages(messages, actorLogin.User.UID, targetLogin.User.UID, actor.PublicID, target.PublicID), nil
}

func (s *Service) Send(ctx context.Context, actorID uint, recipientPublicID, content string) (ChatMessage, error) {
	content = strings.TrimSpace(content)
	if content == "" || len([]rune(content)) > 4000 {
		return ChatMessage{}, fmt.Errorf("message must contain 1 to 4000 characters")
	}
	actor, _, actorLogin, targetLogin, err := s.resolveChat(ctx, actorID, recipientPublicID)
	if err != nil {
		return ChatMessage{}, err
	}
	mid, err := s.voce.Send(ctx, actorLogin.Token, targetLogin.User.UID, content)
	if err != nil {
		return ChatMessage{}, err
	}
	return ChatMessage{ID: mid, FromUserPublicID: actor.PublicID, Content: content, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}, nil
}

func (s *Service) Events(ctx context.Context, actorID uint, afterMID int64) (*http.Response, error) {
	if !s.Enabled() {
		return nil, ErrDisabled
	}
	actor, err := s.users.GetByID(ctx, actorID)
	if err != nil {
		return nil, err
	}
	if actor == nil || !available(*actor) {
		return nil, ErrRecipientUnavailable
	}
	login, err := s.loginAndBind(ctx, *actor)
	if err != nil {
		return nil, err
	}
	return s.voce.Events(ctx, login.Token, afterMID)
}

// EventSenderPublicID translates a VoceChat event sender back to the active
// DEEIX identity. The browser can then track unread messages without depending
// on VoceChat's internal user IDs.
func (s *Service) EventSenderPublicID(ctx context.Context, voceUID int64) (string, error) {
	if s.bindings == nil || voceUID <= 0 {
		return "", ErrRecipientUnavailable
	}
	binding, err := s.bindings.FindByVoceUID(ctx, voceUID)
	if err != nil || binding == nil {
		return "", ErrRecipientUnavailable
	}
	user, err := s.users.GetByPublicID(ctx, binding.UserPublicID)
	if err != nil || user == nil || !available(*user) {
		return "", ErrRecipientUnavailable
	}
	return user.PublicID, nil
}

func (s *Service) resolveChat(ctx context.Context, actorID uint, recipientPublicID string) (*domainuser.User, *domainuser.User, vocechat.Login, vocechat.Login, error) {
	if !s.Enabled() {
		return nil, nil, vocechat.Login{}, vocechat.Login{}, ErrDisabled
	}
	actor, err := s.users.GetByID(ctx, actorID)
	if err != nil {
		return nil, nil, vocechat.Login{}, vocechat.Login{}, err
	}
	if actor == nil {
		return nil, nil, vocechat.Login{}, vocechat.Login{}, ErrRecipientUnavailable
	}
	target, err := s.users.GetByPublicID(ctx, recipientPublicID)
	if err != nil {
		return nil, nil, vocechat.Login{}, vocechat.Login{}, err
	}
	if target == nil {
		return nil, nil, vocechat.Login{}, vocechat.Login{}, ErrRecipientUnavailable
	}
	if actor.ID == target.ID || !available(*actor) || !available(*target) {
		return nil, nil, vocechat.Login{}, vocechat.Login{}, ErrRecipientUnavailable
	}
	actorLogin, err := s.loginAndBind(ctx, *actor)
	if err != nil {
		return nil, nil, vocechat.Login{}, vocechat.Login{}, err
	}
	targetLogin, err := s.loginAndBind(ctx, *target)
	if err != nil {
		return nil, nil, vocechat.Login{}, vocechat.Login{}, err
	}
	return actor, target, actorLogin, targetLogin, nil
}

func (s *Service) loginAndBind(ctx context.Context, user domainuser.User) (vocechat.Login, error) {
	// Existing bindings need a fresh short-lived token but no provisioning lock.
	if s.bindings != nil {
		if binding, err := s.bindings.FindByUserID(ctx, user.ID); err == nil {
			return s.loginExisting(ctx, user, binding)
		}
	}

	entry, _ := s.provisioningLock.LoadOrStore(user.ID, &sync.Mutex{})
	lock := entry.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()

	// A concurrent local request may have completed while this request waited.
	if s.bindings != nil {
		if binding, err := s.bindings.FindByUserID(ctx, user.ID); err == nil {
			return s.loginExisting(ctx, user, binding)
		}
	}
	login, err := s.login(ctx, user)
	if err != nil {
		return vocechat.Login{}, err
	}
	if s.bindings != nil {
		if err = s.bindings.Upsert(ctx, domainmessaging.Binding{UserID: user.ID, UserPublicID: user.PublicID, VoceUID: login.User.UID, SyncedName: voceName(user), SyncedAt: time.Now().UTC()}); err != nil {
			return vocechat.Login{}, err
		}
	}
	return login, nil
}

func (s *Service) loginExisting(ctx context.Context, user domainuser.User, binding *domainmessaging.Binding) (vocechat.Login, error) {
	login, err := s.login(ctx, user)
	if err != nil {
		return vocechat.Login{}, err
	}
	name := voceName(user)
	if binding == nil || binding.SyncedName == name {
		return login, nil
	}
	if err := s.voce.UpdateName(ctx, login.Token, name); err != nil {
		// DEEIX is authoritative for presentation. Retry this optional remote
		// profile synchronization later without blocking an otherwise valid DM.
		return login, nil
	}
	if err := s.bindings.Upsert(ctx, domainmessaging.Binding{UserID: user.ID, UserPublicID: user.PublicID, VoceUID: login.User.UID, SyncedName: name, SyncedAt: time.Now().UTC()}); err != nil {
		return vocechat.Login{}, err
	}
	return login, nil
}

func (s *Service) login(ctx context.Context, user domainuser.User) (vocechat.Login, error) {
	// Separate DEEIX processes can race on a user's very first VoceChat login.
	// VoceChat's unique third_party_users row resolves the winner; retrying lets
	// the loser perform a normal login after that row becomes visible.
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		login, err := s.voce.LoginAs(ctx, user.PublicID, voceName(user))
		if err == nil {
			return login, nil
		}
		lastErr = err
		if attempt == 2 {
			break
		}
		timer := time.NewTimer(time.Duration(attempt+1) * 100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return vocechat.Login{}, ctx.Err()
		case <-timer.C:
		}
	}
	return vocechat.Login{}, lastErr
}
func (s *Service) toMessages(items []vocechat.Message, actorUID, targetUID int64, actorPublicID, targetPublicID string) []ChatMessage {
	results := make([]ChatMessage, 0, len(items))
	for _, item := range items {
		if item.Detail.Type != "normal" && item.Detail.Type != "reply" {
			continue
		}
		from := targetPublicID
		if item.FromUID == actorUID {
			from = actorPublicID
		}
		results = append(results, ChatMessage{ID: item.MID, FromUserPublicID: from, Content: item.Detail.Content, CreatedAt: item.CreatedAtRFC3339()})
	}
	return results
}
func available(user domainuser.User) bool { return user.Status == domainuser.StatusActive }
func displayName(user domainuser.User) string {
	if strings.TrimSpace(user.DisplayName) != "" {
		return user.DisplayName
	}
	return user.Username
}
func voceName(user domainuser.User) string {
	name := strings.TrimSpace(displayName(user))
	runes := []rune(name)
	if len(runes) > 32 {
		return string(runes[:32])
	}
	return name
}
func toDirectoryUser(user domainuser.User) DirectoryUser {
	return DirectoryUser{PublicID: user.PublicID, Username: user.Username, DisplayName: displayName(user), AvatarURL: user.AvatarURL}
}
