package internalmessaging

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"golang.org/x/sync/singleflight"
	"io"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	domainmessaging "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/internalmessaging"
	domainuser "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/user"
	vocechat "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/vocechat"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/apperr"
)

var (
	ErrDisabled             = apperr.New("internal_messaging.disabled", "internal messaging is disabled")
	ErrRecipientUnavailable = apperr.New("internal_messaging.recipient_unavailable", "recipient is unavailable")
	ErrMessageUnavailable   = apperr.New("internal_messaging.message_unavailable", "message is unavailable")
	ErrFileTooLarge         = apperr.New("internal_messaging.file_too_large", "file exceeds the configured size limit")
	ErrQuotaExceeded        = apperr.New("internal_messaging.quota_exceeded", "file quota exceeded")
)

const (
	MaxFileBytes         int64 = 20 << 20
	voceLoginCacheTTL          = 30 * time.Second
	historyPageSize            = 50
	historyRawFetchLimit       = 100
	historyMaxRawPages         = 10
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

type conversationStore interface {
	RecordMessage(context.Context, domainmessaging.MessageIndex) (bool, error)
	RecordMessages(context.Context, []domainmessaging.MessageIndex) error
	ListConversations(context.Context, uint, int, int) ([]domainmessaging.ConversationState, int64, int64, error)
	TotalUnread(context.Context, uint) (int64, error)
	MarkRead(context.Context, uint, uint, int64) error
	SetConversationPreferences(context.Context, uint, uint, *bool, *bool) error
	SearchMessages(context.Context, uint, uint, string, int64, int) ([]domainmessaging.MessageIndex, error)
	UserFileBytes(context.Context, uint) (int64, error)
	MessageStats(context.Context) (int64, int64, error)
	ListMessagesBefore(context.Context, time.Time, int) ([]domainmessaging.MessageIndex, error)
	FindMessage(context.Context, uint, int64) (*domainmessaging.MessageIndex, error)
	FindMessages(context.Context, uint, []int64) ([]domainmessaging.MessageIndex, error)
	EditMessage(context.Context, uint, int64, string, string, string) error
	DeleteMessage(context.Context, uint, int64) error
	ApplyReaction(context.Context, uint, int64, int64, string, string, string, bool) error
}

type voceClient interface {
	Healthy(context.Context) bool
	LoginAs(context.Context, string, string) (vocechat.Login, error)
	History(context.Context, string, int64, int64, int) ([]vocechat.Message, error)
	Send(context.Context, string, int64, string) (int64, error)
	Reply(context.Context, string, int64, string) (int64, error)
	Edit(context.Context, string, int64, string) (int64, error)
	Delete(context.Context, string, int64) (int64, error)
	UploadFileStream(context.Context, string, string, string, io.Reader, int64) (vocechat.UploadedFile, error)
	SendFile(context.Context, string, int64, string) (int64, error)
	DownloadFile(context.Context, string, string, bool) (*http.Response, error)
	UpdateName(context.Context, string, string) error
	Events(context.Context, string, int64) (*http.Response, error)
}

type Service struct {
	eventWork       singleflight.Group
	eventMu         sync.Mutex
	processedEvents map[int64]processedEvent
	configured      bool
	users           userStore
	bindings        bindingStore
	conversations   conversationStore
	voce            voceClient
	loginLock       sync.Map // map[uint]*sync.Mutex; prevents login/provisioning stampedes
	loginCache      sync.Map // map[uint]cachedVoceLogin; server-memory only
	policyProvider  func() Policy
	activeSSE       atomic.Int64
	voceRequests    atomic.Int64
	voceFailures    atomic.Int64
	voceLatencyNS   atomic.Int64
	indexFailures   atomic.Int64
}

type cachedVoceLogin struct {
	login     vocechat.Login
	expiresAt time.Time
}

type Policy struct {
	Enabled                     bool
	MaxFileBytes                int64
	RetentionDays               int
	UserQuotaBytes              int64
	BrowserNotificationsAllowed bool
}

type RuntimeStats struct {
	Configured          bool
	Enabled             bool
	Healthy             bool
	ActiveSSE           int64
	VoceRequests        int64
	VoceFailures        int64
	AverageLatencyMS    int64
	IndexFailures       int64
	PendingIndexRepairs int64
	IndexedMessages     int64
	FileBytes           int64
	Policy              Policy
}

type DirectoryUser struct{ PublicID, Username, DisplayName, AvatarURL string }
type PresenceUser struct {
	PublicID string
	Online   bool
}
type Page struct {
	Total   int64
	Results []DirectoryUser
	HasMore bool
}
type ChatMessage struct {
	ID               int64
	FromUserPublicID string
	ContentType      string
	Content          string
	ReplyToID        int64
	CreatedAt        string
	EditedAt         string
	Deleted          bool
	File             *ChatFile
}

type ChatFile struct {
	Name        string
	ContentType string
	Size        int64
	Image       bool
	Width       uint32
	Height      uint32
}

type indexedFileMetadata struct {
	ChatFile
	Path string `json:"path"`
}

type MessagePage struct {
	Results    []ChatMessage
	HasMore    bool
	NextBefore int64
}

type Conversation struct {
	User               DirectoryUser
	LastMessageID      int64
	LastMessagePreview string
	LastMessageAt      string
	UnreadCount        int64
	Pinned             bool
	Muted              bool
}

type ConversationPage struct {
	Total       int64
	TotalUnread int64
	Results     []Conversation
	HasMore     bool
}

func NewService(enabled bool, users userStore, bindings bindingStore, voce voceClient) *Service {
	state, _ := bindings.(conversationStore)
	return &Service{configured: enabled, users: users, bindings: bindings, conversations: state, voce: voce}
}
func (s *Service) SetPolicyProvider(provider func() Policy) { s.policyProvider = provider }
func (s *Service) policy() Policy {
	policy := Policy{Enabled: s.configured, MaxFileBytes: MaxFileBytes, BrowserNotificationsAllowed: true}
	if s.policyProvider != nil {
		policy = s.policyProvider()
	}
	if policy.MaxFileBytes <= 0 {
		policy.MaxFileBytes = MaxFileBytes
	}
	return policy
}
func (s *Service) Enabled() bool { return s.configured && s.policy().Enabled && s.voce != nil }

// Available reports access to the feature, independently of upstream health.
// A temporary outage must not close the window or discard its selected peer.
func (s *Service) Available(ctx context.Context, actorID uint) bool {
	if !s.Enabled() {
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

func (s *Service) History(ctx context.Context, actorID uint, recipientPublicID string, before int64) (MessagePage, error) {
	actor, target, actorLogin, targetLogin, err := s.resolveChat(ctx, actorID, recipientPublicID)
	if err != nil {
		return MessagePage{}, err
	}
	messages := make([]vocechat.Message, 0, historyRawFetchLimit)
	normalMIDs := make(map[int64]struct{}, historyPageSize+1)
	cursor := before
	exhausted := false
	lastPageFull := false
	for range historyMaxRawPages {
		started := time.Now()
		page, pageErr := s.voce.History(ctx, actorLogin.Token, targetLogin.User.UID, cursor, historyRawFetchLimit)
		s.observeVoce(started, pageErr == nil)
		if pageErr != nil {
			s.loginCache.Delete(actor.ID)
			return MessagePage{}, pageErr
		}
		messages = append(messages, page...)
		for _, item := range page {
			if (item.Detail.Type == "normal" || item.Detail.Type == "reply") && item.MID > 0 {
				normalMIDs[item.MID] = struct{}{}
			}
		}
		lastPageFull = len(page) == historyRawFetchLimit
		if !lastPageFull {
			exhausted = true
			break
		}
		if len(normalMIDs) > historyPageSize {
			break
		}
		nextCursor := int64(0)
		for _, item := range page {
			if item.MID > 0 && (nextCursor == 0 || item.MID < nextCursor) {
				nextCursor = item.MID
			}
		}
		if nextCursor == 0 || nextCursor == cursor {
			// Do not expose a cursor that can only fetch this same raw page.
			exhausted = true
			break
		}
		cursor = nextCursor
	}
	if indexErr := s.recordVoceMessages(ctx, messages, *actor, *target, actorLogin.User.UID); indexErr != nil {
		s.observeIndexError(indexErr)
	}
	results := s.toMessages(ctx, actor.ID, messages, actorLogin.User.UID, targetLogin.User.UID, actor.PublicID, target.PublicID)
	sort.Slice(results, func(first, second int) bool { return results[first].ID < results[second].ID })
	hasMore := len(results) > historyPageSize || (!exhausted && lastPageFull)
	if len(results) > historyPageSize {
		results = results[len(results)-historyPageSize:]
	}
	nextBefore := int64(0)
	for _, item := range results {
		if nextBefore == 0 || item.ID < nextBefore {
			nextBefore = item.ID
		}
	}
	if nextBefore == 0 && cursor != before {
		nextBefore = cursor
	}
	return MessagePage{Results: results, HasMore: hasMore, NextBefore: nextBefore}, nil
}

func (s *Service) Send(ctx context.Context, actorID uint, recipientPublicID, content string) (ChatMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	content = strings.TrimSpace(content)
	if content == "" || len([]rune(content)) > 4000 {
		return ChatMessage{}, fmt.Errorf("message must contain 1 to 4000 characters")
	}
	actor, target, actorLogin, targetLogin, err := s.resolveChat(ctx, actorID, recipientPublicID)
	if err != nil {
		return ChatMessage{}, err
	}
	repairID, repairErr := s.beginIndexRepair(ctx, actor.ID, target.ID)
	if repairErr != nil {
		return ChatMessage{}, repairErr
	}
	started := time.Now()
	mid, err := s.voce.Send(ctx, actorLogin.Token, targetLogin.User.UID, content)
	s.observeVoce(started, err == nil)
	if err != nil {
		s.loginCache.Delete(actor.ID)
		return ChatMessage{}, err
	}
	sentAt := time.Now().UTC()
	indexErr := s.recordIndexedMessage(ctx, domainmessaging.MessageIndex{
		MID: mid, SenderUserID: actor.ID, RecipientUserID: target.ID,
		ContentType: "text/plain", Content: content, SentAt: sentAt,
	})
	s.finishIndexRepair(ctx, repairID, indexErr)
	return ChatMessage{ID: mid, FromUserPublicID: actor.PublicID, ContentType: "text/plain", Content: content, CreatedAt: sentAt.Format(time.RFC3339Nano)}, nil
}

func (s *Service) Reply(ctx context.Context, actorID uint, recipientPublicID string, replyToMID int64, content string) (ChatMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	content = strings.TrimSpace(content)
	if content == "" || len([]rune(content)) > 4000 || replyToMID <= 0 {
		return ChatMessage{}, fmt.Errorf("reply must contain 1 to 4000 characters")
	}
	actor, target, actorLogin, _, err := s.resolveChat(ctx, actorID, recipientPublicID)
	if err != nil {
		return ChatMessage{}, err
	}
	if err = s.requireConversationMessage(ctx, actor.ID, target.ID, replyToMID, false); err != nil {
		return ChatMessage{}, err
	}
	repairID, repairErr := s.beginIndexRepair(ctx, actor.ID, target.ID)
	if repairErr != nil {
		return ChatMessage{}, repairErr
	}
	started := time.Now()
	mid, err := s.voce.Reply(ctx, actorLogin.Token, replyToMID, content)
	s.observeVoce(started, err == nil)
	if err != nil {
		s.loginCache.Delete(actor.ID)
		return ChatMessage{}, err
	}
	sentAt := time.Now().UTC()
	indexErr := s.recordIndexedMessage(ctx, domainmessaging.MessageIndex{
		MID: mid, SenderUserID: actor.ID, RecipientUserID: target.ID,
		ContentType: "text/plain", Content: content, ReplyToMID: replyToMID, SentAt: sentAt,
	})
	s.finishIndexRepair(ctx, repairID, indexErr)
	return ChatMessage{ID: mid, FromUserPublicID: actor.PublicID, ContentType: "text/plain", Content: content, ReplyToID: replyToMID, CreatedAt: sentAt.Format(time.RFC3339Nano)}, nil
}

func (s *Service) Edit(ctx context.Context, actorID uint, mid int64, content string) (ChatMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	content = strings.TrimSpace(content)
	if content == "" || len([]rune(content)) > 4000 || mid <= 0 {
		return ChatMessage{}, fmt.Errorf("message must contain 1 to 4000 characters")
	}
	item, actor, login, err := s.ownedMessage(ctx, actorID, mid)
	if err != nil {
		return ChatMessage{}, err
	}
	if item.Deleted || (item.ContentType != "text/plain" && item.ContentType != "text/markdown") {
		return ChatMessage{}, ErrMessageUnavailable
	}
	repairID, repairErr := s.beginIndexRepair(ctx, actor.ID, item.RecipientUserID)
	if repairErr != nil {
		return ChatMessage{}, repairErr
	}
	started := time.Now()
	reactionMID, err := s.voce.Edit(ctx, login.Token, mid, content)
	s.observeVoce(started, err == nil)
	if err != nil {
		s.loginCache.Delete(actor.ID)
		return ChatMessage{}, err
	}
	indexErr := s.conversations.ApplyReaction(ctx, actor.ID, mid, reactionMID, item.ContentType, content, item.MetadataJSON, false)
	s.finishIndexRepair(ctx, repairID, indexErr)
	item.Content = content
	item.EditedAt = time.Now().UTC()
	return indexedToChatMessage(*item, actor.PublicID), nil
}

func (s *Service) Delete(ctx context.Context, actorID uint, mid int64) error {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	item, actor, login, err := s.ownedMessage(ctx, actorID, mid)
	if err != nil {
		return err
	}
	if item.Deleted {
		return nil
	}
	repairID, repairErr := s.beginIndexRepair(ctx, actor.ID, item.RecipientUserID)
	if repairErr != nil {
		return repairErr
	}
	started := time.Now()
	reactionMID, err := s.voce.Delete(ctx, login.Token, mid)
	s.observeVoce(started, err == nil)
	if err != nil {
		s.loginCache.Delete(actor.ID)
		return err
	}
	indexErr := s.conversations.ApplyReaction(ctx, actor.ID, mid, reactionMID, item.ContentType, "", "{}", true)
	s.finishIndexRepair(ctx, repairID, indexErr)
	return nil
}

func (s *Service) SendFile(ctx context.Context, actorID uint, recipientPublicID, filename, contentType string, content []byte) (ChatMessage, error) {
	return s.SendFileStream(ctx, actorID, recipientPublicID, filename, contentType, bytes.NewReader(content), int64(len(content)))
}

func (s *Service) SendFileStream(ctx context.Context, actorID uint, recipientPublicID, filename, contentType string, content io.Reader, size int64) (ChatMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	policy := s.policy()
	if size <= 0 {
		return ChatMessage{}, fmt.Errorf("file is empty")
	}
	if size > policy.MaxFileBytes {
		return ChatMessage{}, ErrFileTooLarge
	}
	filename = safeFilename(filename)
	if filename == "" {
		filename = "file"
	}
	if contentType == "" || contentType == "application/octet-stream" {
		buffered := bufio.NewReader(content)
		prefix, readErr := buffered.Peek(int(min(size, 512)))
		if readErr != nil && readErr != io.EOF {
			return ChatMessage{}, readErr
		}
		contentType = http.DetectContentType(prefix)
		content = buffered
	}
	actor, target, actorLogin, targetLogin, err := s.resolveChat(ctx, actorID, recipientPublicID)
	if err != nil {
		return ChatMessage{}, err
	}
	if policy.UserQuotaBytes > 0 && s.conversations != nil {
		used, quotaErr := s.conversations.UserFileBytes(ctx, actor.ID)
		if quotaErr != nil {
			return ChatMessage{}, quotaErr
		}
		if used+size > policy.UserQuotaBytes {
			return ChatMessage{}, ErrQuotaExceeded
		}
	}
	repairID, repairErr := s.beginIndexRepair(ctx, actor.ID, target.ID)
	if repairErr != nil {
		return ChatMessage{}, repairErr
	}
	started := time.Now()
	uploaded, err := s.voce.UploadFileStream(ctx, actorLogin.Token, filename, contentType, io.LimitReader(content, size), size)
	s.observeVoce(started, err == nil)
	if err != nil {
		s.loginCache.Delete(actor.ID)
		return ChatMessage{}, err
	}
	started = time.Now()
	mid, err := s.voce.SendFile(ctx, actorLogin.Token, targetLogin.User.UID, uploaded.Path)
	s.observeVoce(started, err == nil)
	if err != nil {
		s.loginCache.Delete(actor.ID)
		return ChatMessage{}, err
	}
	file := ChatFile{Name: filename, ContentType: contentType, Size: uploaded.Size, Image: strings.HasPrefix(contentType, "image/")}
	if uploaded.ImageProperties != nil {
		file.Width, file.Height = uploaded.ImageProperties.Width, uploaded.ImageProperties.Height
	}
	metadata, _ := json.Marshal(indexedFileMetadata{ChatFile: file, Path: uploaded.Path})
	sentAt := time.Now().UTC()
	indexErr := s.recordIndexedMessage(ctx, domainmessaging.MessageIndex{
		MID: mid, SenderUserID: actor.ID, RecipientUserID: target.ID,
		ContentType: "vocechat/file", Content: uploaded.Path, MetadataJSON: string(metadata), FileSize: uploaded.Size, SentAt: sentAt,
	})
	s.finishIndexRepair(ctx, repairID, indexErr)
	return ChatMessage{ID: mid, FromUserPublicID: actor.PublicID, ContentType: "vocechat/file", Content: "", File: &file, CreatedAt: sentAt.Format(time.RFC3339Nano)}, nil
}

func (s *Service) DownloadFile(ctx context.Context, actorID uint, mid int64, thumbnail bool) (*http.Response, ChatFile, error) {
	if !s.Enabled() || s.conversations == nil {
		return nil, ChatFile{}, ErrDisabled
	}
	item, err := s.conversations.FindMessage(ctx, actorID, mid)
	if err != nil || item == nil || item.Deleted || item.ContentType != "vocechat/file" {
		return nil, ChatFile{}, ErrMessageUnavailable
	}
	var metadata indexedFileMetadata
	if json.Unmarshal([]byte(item.MetadataJSON), &metadata) != nil || metadata.Path == "" {
		return nil, ChatFile{}, ErrMessageUnavailable
	}
	actor, err := s.users.GetByID(ctx, actorID)
	if err != nil || actor == nil || !available(*actor) {
		return nil, ChatFile{}, ErrRecipientUnavailable
	}
	login, err := s.loginAndBind(ctx, *actor)
	if err != nil {
		return nil, ChatFile{}, err
	}
	started := time.Now()
	upstream, err := s.voce.DownloadFile(ctx, login.Token, metadata.Path, thumbnail && metadata.Image)
	s.observeVoce(started, err == nil)
	if err != nil {
		s.loginCache.Delete(actor.ID)
		return nil, ChatFile{}, err
	}
	return upstream, metadata.ChatFile, nil
}

func (s *Service) ReadUpload(reader io.Reader, declaredSize int64) ([]byte, error) {
	maxBytes := s.policy().MaxFileBytes
	if declaredSize > maxBytes {
		return nil, ErrFileTooLarge
	}
	content, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(content)) > maxBytes {
		return nil, ErrFileTooLarge
	}
	return content, nil
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
	started := time.Now()
	response, err := s.voce.Events(ctx, login.Token, afterMID)
	s.observeVoce(started, err == nil)
	if err != nil {
		s.loginCache.Delete(actor.ID)
		return nil, err
	}
	s.activeSSE.Add(1)
	response.Body = &trackedBody{ReadCloser: response.Body, closed: func() { s.activeSSE.Add(-1) }}
	return response, nil
}

func (s *Service) BrowserNotificationsAllowed() bool {
	return s.policy().BrowserNotificationsAllowed
}
func (s *Service) CurrentPolicy() Policy { return s.policy() }

func (s *Service) Stats(ctx context.Context) RuntimeStats {
	policy := s.policy()
	healthy := false
	if s.configured && s.voce != nil {
		started := time.Now()
		healthy = s.voce.Healthy(ctx)
		s.observeVoce(started, healthy)
	}
	requests := s.voceRequests.Load()
	latencyMS := int64(0)
	if requests > 0 {
		latencyMS = (s.voceLatencyNS.Load() / requests) / int64(time.Millisecond)
	}
	stats := RuntimeStats{
		Configured: s.configured, Enabled: s.Enabled(), Healthy: healthy,
		ActiveSSE: s.activeSSE.Load(), VoceRequests: requests,
		VoceFailures: s.voceFailures.Load(), IndexFailures: s.indexFailures.Load(), AverageLatencyMS: latencyMS, Policy: policy,
	}
	if s.conversations != nil {
		stats.IndexedMessages, stats.FileBytes, _ = s.conversations.MessageStats(ctx)
	}
	if store, ok := s.conversations.(indexRepairStore); ok {
		stats.PendingIndexRepairs, _ = store.PendingIndexRepairs(ctx)
	}
	return stats
}

func (s *Service) StartBackgroundWorkers(ctx context.Context) {
	if s == nil || s.conversations == nil || s.voce == nil {
		return
	}
	go func() {
		s.repairIndexes(ctx)
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.repairIndexes(ctx)
			}
		}
	}()
	go func() {
		s.cleanupExpired(ctx)
		ticker := time.NewTicker(6 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.cleanupExpired(ctx)
			}
		}
	}()
}

func (s *Service) cleanupExpired(ctx context.Context) {
	retentionDays := s.policy().RetentionDays
	if retentionDays <= 0 || !s.configured {
		return
	}
	items, err := s.conversations.ListMessagesBefore(ctx, time.Now().UTC().Add(-time.Duration(retentionDays)*24*time.Hour), 100)
	if err != nil {
		return
	}
	for _, item := range items {
		if ctx.Err() != nil {
			return
		}
		sender, userErr := s.users.GetByID(ctx, item.SenderUserID)
		if userErr != nil || sender == nil {
			continue
		}
		login, loginErr := s.loginAndBind(ctx, *sender)
		if loginErr != nil {
			continue
		}
		started := time.Now()
		_, deleteErr := s.voce.Delete(ctx, login.Token, item.MID)
		s.observeVoce(started, deleteErr == nil)
		if deleteErr == nil {
			_ = s.conversations.DeleteMessage(ctx, item.SenderUserID, item.MID)
		} else {
			s.loginCache.Delete(sender.ID)
		}
	}
}

func (s *Service) observeVoce(started time.Time, success bool) {
	s.voceRequests.Add(1)
	s.voceLatencyNS.Add(time.Since(started).Nanoseconds())
	if !success {
		s.voceFailures.Add(1)
	}
}

type trackedBody struct {
	io.ReadCloser
	once   sync.Once
	closed func()
}

func (body *trackedBody) Close() error {
	err := body.ReadCloser.Close()
	body.once.Do(body.closed)
	return err
}

func (s *Service) UnreadCount(ctx context.Context, actorID uint) int64 {
	if s.conversations == nil {
		return 0
	}
	total, err := s.conversations.TotalUnread(ctx, actorID)
	if err != nil {
		return 0
	}
	return total
}

func (s *Service) ListConversations(ctx context.Context, actorID uint, page, pageSize int) (ConversationPage, error) {
	if !s.Enabled() {
		return ConversationPage{}, ErrDisabled
	}
	actor, err := s.users.GetByID(ctx, actorID)
	if err != nil || actor == nil || !available(*actor) {
		return ConversationPage{}, ErrRecipientUnavailable
	}
	if s.conversations == nil {
		return ConversationPage{Results: []Conversation{}}, nil
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
	states, total, totalUnread, err := s.conversations.ListConversations(ctx, actorID, (page-1)*pageSize, pageSize)
	if err != nil {
		return ConversationPage{}, err
	}
	peerIDs := make([]uint, 0, len(states))
	for _, state := range states {
		peerIDs = append(peerIDs, state.PeerUserID)
	}
	peers := make(map[uint]domainuser.User, len(states))
	if len(peerIDs) > 0 {
		items, _, usersErr := s.users.ListUsers(ctx, 0, len(peerIDs), repository.UserListFilter{IDs: peerIDs, Status: domainuser.StatusActive})
		if usersErr != nil {
			return ConversationPage{}, usersErr
		}
		for _, peer := range items {
			peers[peer.ID] = peer
		}
	}
	results := make([]Conversation, 0, len(states))
	for _, state := range states {
		peer, exists := peers[state.PeerUserID]
		if !exists || !available(peer) {
			continue
		}
		lastAt := ""
		if !state.LastMessageAt.IsZero() {
			lastAt = state.LastMessageAt.UTC().Format(time.RFC3339Nano)
		}
		results = append(results, Conversation{
			User: toDirectoryUser(peer), LastMessageID: state.LastMessageMID,
			LastMessagePreview: state.LastMessagePreview, LastMessageAt: lastAt,
			UnreadCount: state.UnreadCount, Pinned: state.Pinned, Muted: state.Muted,
		})
	}
	return ConversationPage{Total: total, TotalUnread: totalUnread, Results: results, HasMore: int64(page*pageSize) < total}, nil
}

func (s *Service) MarkRead(ctx context.Context, actorID uint, recipientPublicID string, throughMID int64) error {
	if s.conversations == nil {
		return nil
	}
	actor, target, err := s.resolveParticipants(ctx, actorID, recipientPublicID)
	if err != nil {
		return err
	}
	return s.conversations.MarkRead(ctx, actor.ID, target.ID, throughMID)
}

func (s *Service) SetConversationPreferences(ctx context.Context, actorID uint, recipientPublicID string, pinned, muted *bool) error {
	if s.conversations == nil {
		return nil
	}
	actor, target, err := s.resolveParticipants(ctx, actorID, recipientPublicID)
	if err != nil {
		return err
	}
	return s.conversations.SetConversationPreferences(ctx, actor.ID, target.ID, pinned, muted)
}

func (s *Service) SearchMessages(ctx context.Context, actorID uint, recipientPublicID, query string, beforeMID int64, limit int) (MessagePage, error) {
	if s.conversations == nil {
		return MessagePage{Results: []ChatMessage{}}, nil
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return MessagePage{Results: []ChatMessage{}}, nil
	}
	actor, err := s.users.GetByID(ctx, actorID)
	if err != nil || actor == nil || !available(*actor) {
		return MessagePage{}, ErrRecipientUnavailable
	}
	var peer *domainuser.User
	peerID := uint(0)
	if recipientPublicID != "" {
		peer, err = s.users.GetByPublicID(ctx, recipientPublicID)
		if err != nil || peer == nil || !available(*peer) || peer.ID == actor.ID {
			return MessagePage{}, ErrRecipientUnavailable
		}
		peerID = peer.ID
	}
	if limit < 1 || limit > 100 {
		limit = 50
	}
	items, err := s.conversations.SearchMessages(ctx, actorID, peerID, query, beforeMID, limit+1)
	if err != nil {
		return MessagePage{}, err
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	results := make([]ChatMessage, 0, len(items))
	nextBefore := int64(0)
	for _, item := range items {
		sender, senderErr := s.users.GetByID(ctx, item.SenderUserID)
		if senderErr != nil || sender == nil {
			continue
		}
		results = append(results, indexedToChatMessage(item, sender.PublicID))
		if nextBefore == 0 || item.MID < nextBefore {
			nextBefore = item.MID
		}
	}
	return MessagePage{Results: results, HasMore: hasMore, NextBefore: nextBefore}, nil
}

// ProcessEvent records product state from a VoceChat chat event and returns
// the sender's opaque DEEIX public ID for the browser event envelope.
func (s *Service) processEvent(ctx context.Context, raw string) (string, error) {
	var header struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal([]byte(raw), &header); err != nil || header.Type != "chat" {
		return "", err
	}
	var message vocechat.Message
	if err := json.Unmarshal([]byte(raw), &message); err != nil {
		return "", err
	}
	senderBinding, err := s.bindings.FindByVoceUID(ctx, message.FromUID)
	if err != nil || senderBinding == nil {
		return "", ErrRecipientUnavailable
	}
	recipientBinding, err := s.bindings.FindByVoceUID(ctx, message.Target.UID)
	if err != nil || recipientBinding == nil {
		return "", ErrRecipientUnavailable
	}
	sender, err := s.users.GetByID(ctx, senderBinding.UserID)
	if err != nil || sender == nil || !available(*sender) {
		return "", ErrRecipientUnavailable
	}
	recipient, err := s.users.GetByID(ctx, recipientBinding.UserID)
	if err != nil || recipient == nil || !available(*recipient) {
		return "", ErrRecipientUnavailable
	}
	if err := s.recordVoceMessage(ctx, message, *sender, *recipient, message.FromUID); err != nil {
		s.observeIndexError(err)
		return "", err
	}
	return sender.PublicID, nil
}

// EventPresence maps VoceChat's multi-device aggregate presence events onto
// opaque DEEIX identities. Voce UIDs never cross the browser boundary.
func (s *Service) EventPresence(ctx context.Context, raw string) ([]PresenceUser, error) {
	var event struct {
		Type   string `json:"type"`
		UID    int64  `json:"uid"`
		Online bool   `json:"online"`
		Users  []struct {
			UID    int64 `json:"uid"`
			Online bool  `json:"online"`
		} `json:"users"`
	}
	if err := json.Unmarshal([]byte(raw), &event); err != nil {
		return nil, err
	}
	states := event.Users
	if event.Type == "users_state_changed" {
		states = []struct {
			UID    int64 `json:"uid"`
			Online bool  `json:"online"`
		}{{UID: event.UID, Online: event.Online}}
	} else if event.Type != "users_state" {
		return nil, ErrMessageUnavailable
	}
	results := make([]PresenceUser, 0, len(states))
	for _, state := range states {
		binding, err := s.bindings.FindByVoceUID(ctx, state.UID)
		if err != nil || binding == nil {
			continue
		}
		user, err := s.users.GetByID(ctx, binding.UserID)
		if err != nil || user == nil || !available(*user) {
			continue
		}
		results = append(results, PresenceUser{PublicID: user.PublicID, Online: state.Online})
	}
	return results, nil
}

// EventMessage returns the canonical, browser-safe message state after an SSE
// event has been persisted. FindMessage enforces that the authenticated actor
// participates in the conversation, so an upstream MID can never be used to
// expose another user's message.
func (s *Service) EventMessage(ctx context.Context, actorID uint, mid int64) (ChatMessage, string, error) {
	if s.conversations == nil || mid <= 0 {
		return ChatMessage{}, "", ErrMessageUnavailable
	}
	item, err := s.conversations.FindMessage(ctx, actorID, mid)
	if err != nil || item == nil {
		return ChatMessage{}, "", ErrMessageUnavailable
	}
	sender, err := s.users.GetByID(ctx, item.SenderUserID)
	if err != nil || sender == nil || !available(*sender) {
		return ChatMessage{}, "", ErrRecipientUnavailable
	}
	peerID := item.SenderUserID
	if peerID == actorID {
		peerID = item.RecipientUserID
	}
	peer, err := s.users.GetByID(ctx, peerID)
	if err != nil || peer == nil || !available(*peer) {
		return ChatMessage{}, "", ErrRecipientUnavailable
	}
	return indexedToChatMessage(*item, sender.PublicID), peer.PublicID, nil
}

func (s *Service) resolveChat(ctx context.Context, actorID uint, recipientPublicID string) (*domainuser.User, *domainuser.User, vocechat.Login, vocechat.Login, error) {
	actor, target, err := s.resolveParticipants(ctx, actorID, recipientPublicID)
	if err != nil {
		return nil, nil, vocechat.Login{}, vocechat.Login{}, err
	}
	actorLogin, err := s.loginAndBind(ctx, *actor)
	if err != nil {
		return nil, nil, vocechat.Login{}, vocechat.Login{}, err
	}
	targetLogin, err := s.resolveTargetLogin(ctx, *target)
	if err != nil {
		return nil, nil, vocechat.Login{}, vocechat.Login{}, err
	}
	return actor, target, actorLogin, targetLogin, nil
}

func (s *Service) resolveTargetLogin(ctx context.Context, target domainuser.User) (vocechat.Login, error) {
	if s.bindings != nil {
		if binding, err := s.bindings.FindByUserID(ctx, target.ID); err == nil && binding != nil && binding.VoceUID > 0 {
			return vocechat.Login{User: vocechat.User{UID: binding.VoceUID}}, nil
		}
	}
	return s.loginAndBind(ctx, target)
}

func (s *Service) resolveParticipants(ctx context.Context, actorID uint, recipientPublicID string) (*domainuser.User, *domainuser.User, error) {
	if !s.Enabled() {
		return nil, nil, ErrDisabled
	}
	actor, err := s.users.GetByID(ctx, actorID)
	if err != nil {
		return nil, nil, err
	}
	if actor == nil {
		return nil, nil, ErrRecipientUnavailable
	}
	target, err := s.users.GetByPublicID(ctx, recipientPublicID)
	if err != nil {
		return nil, nil, err
	}
	if target == nil {
		return nil, nil, ErrRecipientUnavailable
	}
	if actor.ID == target.ID || !available(*actor) || !available(*target) {
		return nil, nil, ErrRecipientUnavailable
	}
	return actor, target, nil
}

func (s *Service) loginAndBind(ctx context.Context, user domainuser.User) (vocechat.Login, error) {
	if cached, ok := s.cachedLogin(user.ID); ok {
		return cached, nil
	}

	entry, _ := s.loginLock.LoadOrStore(user.ID, &sync.Mutex{})
	lock := entry.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()

	if cached, ok := s.cachedLogin(user.ID); ok {
		return cached, nil
	}

	var login vocechat.Login
	var err error
	if s.bindings != nil {
		if binding, err := s.bindings.FindByUserID(ctx, user.ID); err == nil {
			login, err = s.loginExisting(ctx, user, binding)
			if err == nil {
				s.cacheLogin(user.ID, login)
			}
			return login, err
		}
	}
	login, err = s.login(ctx, user)
	if err != nil {
		return vocechat.Login{}, err
	}
	if s.bindings != nil {
		if err = s.bindings.Upsert(ctx, domainmessaging.Binding{UserID: user.ID, UserPublicID: user.PublicID, VoceUID: login.User.UID, SyncedName: voceName(user), SyncedAt: time.Now().UTC()}); err != nil {
			return vocechat.Login{}, err
		}
	}
	s.cacheLogin(user.ID, login)
	return login, nil
}

func (s *Service) cachedLogin(userID uint) (vocechat.Login, bool) {
	value, ok := s.loginCache.Load(userID)
	if !ok {
		return vocechat.Login{}, false
	}
	cached, ok := value.(cachedVoceLogin)
	if !ok || cached.login.Token == "" || cached.login.User.UID <= 0 || time.Now().After(cached.expiresAt) {
		s.loginCache.Delete(userID)
		return vocechat.Login{}, false
	}
	return cached.login, true
}

func (s *Service) cacheLogin(userID uint, login vocechat.Login) {
	if userID == 0 || login.Token == "" || login.User.UID <= 0 {
		return
	}
	s.loginCache.Store(userID, cachedVoceLogin{
		login:     login,
		expiresAt: time.Now().Add(voceLoginCacheTTL),
	})
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
	started := time.Now()
	err = s.voce.UpdateName(ctx, login.Token, name)
	s.observeVoce(started, err == nil)
	if err != nil {
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
		started := time.Now()
		login, err := s.voce.LoginAs(ctx, user.PublicID, voceName(user))
		s.observeVoce(started, err == nil)
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
func (s *Service) toMessages(ctx context.Context, actorID uint, items []vocechat.Message, actorUID, targetUID int64, actorPublicID, targetPublicID string) []ChatMessage {
	byMID := make(map[int64]ChatMessage, len(items))
	order := make([]int64, 0, len(items))
	indexedByMID := make(map[int64]domainmessaging.MessageIndex, len(items))
	if s.conversations != nil {
		mids := make([]int64, 0, len(items))
		seen := make(map[int64]struct{}, len(items))
		for _, item := range items {
			if (item.Detail.Type == "normal" || item.Detail.Type == "reply") && item.MID > 0 {
				if _, exists := seen[item.MID]; !exists {
					seen[item.MID] = struct{}{}
					mids = append(mids, item.MID)
				}
			}
		}
		if indexed, err := s.conversations.FindMessages(ctx, actorID, mids); err == nil {
			for _, item := range indexed {
				indexedByMID[item.MID] = item
			}
		}
	}
	for _, item := range items {
		if item.Detail.Type != "normal" && item.Detail.Type != "reply" {
			continue
		}
		from := targetPublicID
		if item.FromUID == actorUID {
			from = actorPublicID
		}
		contentType := item.Detail.ContentType
		if contentType == "" {
			contentType = "text/plain"
		}
		message := ChatMessage{
			ID: item.MID, FromUserPublicID: from, ContentType: contentType,
			Content: item.Detail.Content, ReplyToID: item.Detail.MID, CreatedAt: item.CreatedAtRFC3339(),
		}
		if indexed, exists := indexedByMID[item.MID]; exists {
			message = indexedToChatMessage(indexed, from)
		}
		if contentType == "vocechat/file" {
			if message.File == nil {
				metadata := fileMetadataFromVoce(item)
				message.Content = ""
				message.File = &metadata.ChatFile
			}
		}
		if _, exists := byMID[item.MID]; !exists {
			order = append(order, item.MID)
		}
		byMID[item.MID] = message
	}
	for index := len(items) - 1; index >= 0; index-- {
		item := items[index]
		if item.Detail.Type != "reaction" || item.Detail.MID <= 0 {
			continue
		}
		if indexed, exists := indexedByMID[item.Detail.MID]; exists && (indexed.Deleted || indexed.LastEventMID >= item.MID) {
			continue
		}
		original, ok := byMID[item.Detail.MID]
		if !ok {
			continue
		}
		switch item.Detail.Reaction.Type {
		case "edit":
			original.Content = item.Detail.Reaction.Content
			if item.Detail.Reaction.ContentType != "" {
				original.ContentType = item.Detail.Reaction.ContentType
			}
			original.EditedAt = item.CreatedAtRFC3339()
		case "delete":
			original.Content = ""
			original.File = nil
			original.Deleted = true
		}
		byMID[item.Detail.MID] = original
	}
	results := make([]ChatMessage, 0, len(order))
	for _, mid := range order {
		results = append(results, byMID[mid])
	}
	return results
}

func (s *Service) recordVoceMessage(ctx context.Context, item vocechat.Message, first, second domainuser.User, firstVoceUID int64) error {
	if s.conversations == nil {
		return nil
	}
	sender, recipient := first, second
	if item.FromUID != firstVoceUID {
		sender, recipient = second, first
	}
	if item.Detail.Type == "reaction" {
		contentType := item.Detail.Reaction.ContentType
		if contentType == "" {
			contentType = "text/plain"
		}
		metadata, _ := json.Marshal(item.Detail.Reaction.Properties)
		switch item.Detail.Reaction.Type {
		case "edit", "delete":
			return s.conversations.ApplyReaction(ctx, sender.ID, item.Detail.MID, item.MID, contentType, item.Detail.Reaction.Content, string(metadata), item.Detail.Reaction.Type == "delete")
		}
		return nil
	}
	indexed, ok := voceMessageIndex(item, sender, recipient)
	if !ok {
		return nil
	}
	return s.recordIndexedMessage(ctx, indexed)
}

func (s *Service) recordVoceMessages(ctx context.Context, items []vocechat.Message, first, second domainuser.User, firstVoceUID int64) error {
	if s.conversations == nil {
		return nil
	}
	indexed := make([]domainmessaging.MessageIndex, 0, len(items))
	for _, item := range items {
		sender, recipient := first, second
		if item.FromUID != firstVoceUID {
			sender, recipient = second, first
		}
		if message, ok := voceMessageIndex(item, sender, recipient); ok {
			indexed = append(indexed, message)
		}
	}
	if err := s.conversations.RecordMessages(ctx, indexed); err != nil {
		return err
	}
	ordered := append([]vocechat.Message(nil), items...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].MID < ordered[j].MID })
	for _, item := range ordered {
		if item.Detail.Type == "reaction" {
			if err := s.recordVoceMessage(ctx, item, first, second, firstVoceUID); err != nil {
				return err
			}
		}
	}
	return nil
}

func voceMessageIndex(item vocechat.Message, sender, recipient domainuser.User) (domainmessaging.MessageIndex, bool) {
	if item.Detail.Type != "normal" && item.Detail.Type != "reply" {
		return domainmessaging.MessageIndex{}, false
	}
	contentType := item.Detail.ContentType
	if contentType == "" {
		contentType = "text/plain"
	}
	sentAt := time.Now().UTC()
	if value := item.CreatedAtRFC3339(); value != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
			sentAt = parsed.UTC()
		}
	}
	metadata := ""
	fileSize := int64(0)
	if contentType == "vocechat/file" {
		fileMetadata := fileMetadataFromVoce(item)
		fileSize = fileMetadata.Size
		encoded, _ := json.Marshal(fileMetadata)
		metadata = string(encoded)
	}
	return domainmessaging.MessageIndex{
		MID: item.MID, SenderUserID: sender.ID, RecipientUserID: recipient.ID,
		ContentType: contentType, Content: item.Detail.Content, MetadataJSON: metadata, FileSize: fileSize,
		ReplyToMID: item.Detail.MID, SentAt: sentAt,
	}, true
}

func (s *Service) recordIndexedMessage(ctx context.Context, item domainmessaging.MessageIndex) error {
	if s.conversations == nil || item.MID <= 0 || item.SenderUserID == 0 || item.RecipientUserID == 0 {
		return nil
	}
	_, err := s.conversations.RecordMessage(ctx, item)
	return err
}

func indexedToChatMessage(item domainmessaging.MessageIndex, senderPublicID string) ChatMessage {
	createdAt := ""
	if !item.SentAt.IsZero() {
		createdAt = item.SentAt.UTC().Format(time.RFC3339Nano)
	}
	editedAt := ""
	if !item.EditedAt.IsZero() {
		editedAt = item.EditedAt.UTC().Format(time.RFC3339Nano)
	}
	message := ChatMessage{
		ID: item.MID, FromUserPublicID: senderPublicID, ContentType: item.ContentType,
		Content: item.Content, ReplyToID: item.ReplyToMID, CreatedAt: createdAt,
		EditedAt: editedAt, Deleted: item.Deleted,
	}
	if item.ContentType == "vocechat/file" && !item.Deleted {
		var metadata indexedFileMetadata
		if json.Unmarshal([]byte(item.MetadataJSON), &metadata) == nil {
			message.Content = ""
			message.File = &metadata.ChatFile
		}
	}
	return message
}

func (s *Service) requireConversationMessage(ctx context.Context, actorID, peerID uint, mid int64, owned bool) error {
	if s.conversations == nil {
		return ErrMessageUnavailable
	}
	item, err := s.conversations.FindMessage(ctx, actorID, mid)
	if err != nil || item == nil || item.Deleted {
		return ErrMessageUnavailable
	}
	if owned && item.SenderUserID != actorID {
		return ErrMessageUnavailable
	}
	if !((item.SenderUserID == actorID && item.RecipientUserID == peerID) || (item.SenderUserID == peerID && item.RecipientUserID == actorID)) {
		return ErrMessageUnavailable
	}
	return nil
}

func (s *Service) ownedMessage(ctx context.Context, actorID uint, mid int64) (*domainmessaging.MessageIndex, *domainuser.User, vocechat.Login, error) {
	if !s.Enabled() || s.conversations == nil {
		return nil, nil, vocechat.Login{}, ErrDisabled
	}
	actor, err := s.users.GetByID(ctx, actorID)
	if err != nil || actor == nil || !available(*actor) {
		return nil, nil, vocechat.Login{}, ErrRecipientUnavailable
	}
	item, err := s.conversations.FindMessage(ctx, actorID, mid)
	if err != nil || item == nil || item.SenderUserID != actorID {
		return nil, nil, vocechat.Login{}, ErrMessageUnavailable
	}
	login, err := s.loginAndBind(ctx, *actor)
	if err != nil {
		return nil, nil, vocechat.Login{}, err
	}
	return item, actor, login, nil
}

func safeFilename(value string) string {
	value = filepath.Base(strings.ReplaceAll(value, "\\", "/"))
	value = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 || r == '/' || r == '\\' {
			return -1
		}
		return r
	}, value)
	runes := []rune(strings.TrimSpace(value))
	if len(runes) > 180 {
		runes = runes[:180]
	}
	return string(runes)
}

func fileMetadataFromVoce(item vocechat.Message) indexedFileMetadata {
	metadata := indexedFileMetadata{Path: item.Detail.Content}
	decode := func(key string, output any) {
		if raw, ok := item.Detail.Properties[key]; ok {
			_ = json.Unmarshal(raw, output)
		}
	}
	decode("name", &metadata.Name)
	decode("content_type", &metadata.ContentType)
	decode("size", &metadata.Size)
	decode("width", &metadata.Width)
	decode("height", &metadata.Height)
	if metadata.Name == "" {
		metadata.Name = "file"
	}
	if metadata.ContentType == "" {
		metadata.ContentType = "application/octet-stream"
	}
	metadata.Image = strings.HasPrefix(metadata.ContentType, "image/")
	return metadata
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
