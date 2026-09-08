package internalmessaging

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"strconv"
	"strings"

	appaudit "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/audit"
	app "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/internalmessaging"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/apperr"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/response"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/middleware"
	"github.com/gin-gonic/gin"
)

var errUnavailable = apperr.New("internal_messaging.unavailable", "internal messaging is unavailable")

type auditWriter interface {
	Write(context.Context, appaudit.WriteInput)
}

type Handler struct {
	service *app.Service
	audit   auditWriter
}

func NewHandler(service *app.Service) *Handler       { return &Handler{service: service} }
func (h *Handler) SetAuditWriter(writer auditWriter) { h.audit = writer }

type sendRequest struct {
	Content string `json:"content" binding:"required,max=16000"`
}
type replyRequest struct {
	Content   string `json:"content" binding:"required,max=16000"`
	ReplyToID int64  `json:"replyToID" binding:"required"`
}
type editRequest struct {
	Content string `json:"content" binding:"required,max=16000"`
}
type statusResponse struct {
	Enabled              bool  `json:"enabled"`
	UnreadCount          int64 `json:"unreadCount"`
	MaxFileBytes         int64 `json:"maxFileBytes"`
	BrowserNotifications bool  `json:"browserNotifications"`
}
type directoryUserResponse struct {
	PublicID    string `json:"publicID"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	AvatarURL   string `json:"avatarURL"`
}
type directoryResponse struct {
	Total   int64                   `json:"total"`
	Results []directoryUserResponse `json:"results"`
	HasMore bool                    `json:"hasMore"`
}
type messageResponse struct {
	ID               int64         `json:"id"`
	FromUserPublicID string        `json:"fromUserPublicID"`
	ContentType      string        `json:"contentType"`
	Content          string        `json:"content"`
	ReplyToID        int64         `json:"replyToID"`
	CreatedAt        string        `json:"createdAt"`
	EditedAt         string        `json:"editedAt"`
	Deleted          bool          `json:"deleted"`
	File             *fileResponse `json:"file,omitempty"`
}
type fileResponse struct {
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
	Image       bool   `json:"image"`
	Width       uint32 `json:"width"`
	Height      uint32 `json:"height"`
}
type adminStatusResponse struct {
	Configured          bool  `json:"configured"`
	Enabled             bool  `json:"enabled"`
	Healthy             bool  `json:"healthy"`
	ActiveSSE           int64 `json:"activeSSE"`
	VoceRequests        int64 `json:"voceRequests"`
	VoceFailures        int64 `json:"voceFailures"`
	AverageLatencyMS    int64 `json:"averageLatencyMS"`
	IndexFailures       int64 `json:"indexFailures"`
	PendingIndexRepairs int64 `json:"pendingIndexRepairs"`
	IndexedMessages     int64 `json:"indexedMessages"`
	FileBytes           int64 `json:"fileBytes"`
}
type messagePageResponse struct {
	Results    []messageResponse `json:"results"`
	HasMore    bool              `json:"hasMore"`
	NextBefore int64             `json:"nextBefore"`
}
type conversationResponse struct {
	User               directoryUserResponse `json:"user"`
	LastMessageID      int64                 `json:"lastMessageID"`
	LastMessagePreview string                `json:"lastMessagePreview"`
	LastMessageAt      string                `json:"lastMessageAt"`
	UnreadCount        int64                 `json:"unreadCount"`
	Pinned             bool                  `json:"pinned"`
	Muted              bool                  `json:"muted"`
}
type conversationPageResponse struct {
	Total       int64                  `json:"total"`
	TotalUnread int64                  `json:"totalUnread"`
	Results     []conversationResponse `json:"results"`
	HasMore     bool                   `json:"hasMore"`
}
type markReadRequest struct {
	ThroughMID int64 `json:"throughMID"`
}
type preferenceRequest struct {
	Pinned *bool `json:"pinned"`
	Muted  *bool `json:"muted"`
}

func (h *Handler) Status(c *gin.Context) {
	actorID := middleware.MustUserID(c)
	enabled := h.service != nil && h.service.Available(c.Request.Context(), actorID)
	unread := int64(0)
	if enabled {
		unread = h.service.UnreadCount(c.Request.Context(), actorID)
	}
	maxFileBytes := int64(app.MaxFileBytes)
	browserNotifications := false
	if h.service != nil {
		maxFileBytes = h.service.CurrentPolicy().MaxFileBytes
		browserNotifications = h.service.BrowserNotificationsAllowed()
	}
	response.Success(c, statusResponse{Enabled: enabled, UnreadCount: unread, MaxFileBytes: maxFileBytes, BrowserNotifications: browserNotifications})
}

func (h *Handler) ListConversations(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "30"))
	items, err := h.service.ListConversations(c.Request.Context(), middleware.MustUserID(c), page, pageSize)
	if err != nil {
		writeError(c, err)
		return
	}
	results := make([]conversationResponse, 0, len(items.Results))
	for _, item := range items.Results {
		results = append(results, conversationResponse{
			User:          directoryUserResponse{PublicID: item.User.PublicID, Username: item.User.Username, DisplayName: item.User.DisplayName, AvatarURL: item.User.AvatarURL},
			LastMessageID: item.LastMessageID, LastMessagePreview: item.LastMessagePreview,
			LastMessageAt: item.LastMessageAt, UnreadCount: item.UnreadCount,
			Pinned: item.Pinned, Muted: item.Muted,
		})
	}
	response.Success(c, conversationPageResponse{Total: items.Total, TotalUnread: items.TotalUnread, Results: results, HasMore: items.HasMore})
}

func (h *Handler) ListUsers(c *gin.Context) {
	if h.service == nil {
		response.ErrorFrom(c, http.StatusServiceUnavailable, app.ErrDisabled)
		return
	}
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "30"))
	items, err := h.service.ListUsers(c.Request.Context(), middleware.MustUserID(c), c.Query("query"), page, pageSize)
	if err != nil {
		writeError(c, err)
		return
	}
	results := make([]directoryUserResponse, 0, len(items.Results))
	for _, item := range items.Results {
		results = append(results, directoryUserResponse{PublicID: item.PublicID, Username: item.Username, DisplayName: item.DisplayName, AvatarURL: item.AvatarURL})
	}
	response.Success(c, directoryResponse{Total: items.Total, Results: results, HasMore: items.HasMore})
}

func (h *Handler) History(c *gin.Context) {
	before, _ := strconv.ParseInt(c.Query("before"), 10, 64)
	items, err := h.service.History(c.Request.Context(), middleware.MustUserID(c), c.Param("publicID"), before)
	if err != nil {
		writeError(c, err)
		return
	}
	response.Success(c, toMessagePageResponse(items))
}

func (h *Handler) MarkRead(c *gin.Context) {
	var req markReadRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	if err := h.service.MarkRead(c.Request.Context(), middleware.MustUserID(c), c.Param("publicID"), req.ThroughMID); err != nil {
		writeError(c, err)
		return
	}
	response.Success(c, gin.H{"ok": true})
}

func (h *Handler) SetConversationPreferences(c *gin.Context) {
	var req preferenceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	if err := h.service.SetConversationPreferences(c.Request.Context(), middleware.MustUserID(c), c.Param("publicID"), req.Pinned, req.Muted); err != nil {
		writeError(c, err)
		return
	}
	response.Success(c, gin.H{"ok": true})
}

func (h *Handler) SearchMessages(c *gin.Context) {
	before, _ := strconv.ParseInt(c.Query("before"), 10, 64)
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	items, err := h.service.SearchMessages(c.Request.Context(), middleware.MustUserID(c), c.Query("public_id"), c.Query("query"), before, limit)
	if err != nil {
		writeError(c, err)
		return
	}
	response.Success(c, toMessagePageResponse(items))
}

func (h *Handler) Send(c *gin.Context) {
	var req sendRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	item, err := h.service.Send(c.Request.Context(), middleware.MustUserID(c), c.Param("publicID"), req.Content)
	if err != nil {
		writeError(c, err)
		return
	}
	response.Success(c, toMessageResponse(item))
}

func (h *Handler) Reply(c *gin.Context) {
	var req replyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	item, err := h.service.Reply(c.Request.Context(), middleware.MustUserID(c), c.Param("publicID"), req.ReplyToID, req.Content)
	if err != nil {
		writeError(c, err)
		return
	}
	response.Success(c, toMessageResponse(item))
}

func (h *Handler) Edit(c *gin.Context) {
	var req editRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	item, err := h.service.Edit(c.Request.Context(), middleware.MustUserID(c), parseMID(c), req.Content)
	if err != nil {
		writeError(c, err)
		return
	}
	h.writeAudit(c, "internal_message_edit", parseMID(c), nil)
	response.Success(c, toMessageResponse(item))
}

func (h *Handler) Delete(c *gin.Context) {
	if err := h.service.Delete(c.Request.Context(), middleware.MustUserID(c), parseMID(c)); err != nil {
		writeError(c, err)
		return
	}
	h.writeAudit(c, "internal_message_delete", parseMID(c), nil)
	response.Success(c, gin.H{"ok": true})
}

func (h *Handler) SendFile(c *gin.Context) {
	maxBytes := h.service.CurrentPolicy().MaxFileBytes
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes+(1<<20))
	// Spill large parts to disk instead of retaining a copy per concurrent upload.
	parseErr := c.Request.ParseMultipartForm(1 << 20)
	if c.Request.MultipartForm != nil {
		defer c.Request.MultipartForm.RemoveAll()
	}
	if parseErr != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(parseErr, &tooLarge) {
			writeError(c, app.ErrFileTooLarge)
		} else {
			response.InvalidRequestBody(c, parseErr)
		}
		return
	}
	fileHeader, err := c.FormFile("file")
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(c, app.ErrFileTooLarge)
			return
		}
		response.InvalidRequestBody(c, err)
		return
	}
	file, err := fileHeader.Open()
	if err != nil {
		writeError(c, err)
		return
	}
	defer file.Close()
	item, err := h.service.SendFileStream(c.Request.Context(), middleware.MustUserID(c), c.Param("publicID"), fileHeader.Filename, fileHeader.Header.Get("Content-Type"), file, fileHeader.Size)
	if err != nil {
		writeError(c, err)
		return
	}
	detail := map[string]any{}
	if item.File != nil {
		detail = map[string]any{"name": item.File.Name, "size": item.File.Size, "content_type": item.File.ContentType}
	}
	h.writeAudit(c, "internal_message_file_send", item.ID, detail)
	response.Success(c, toMessageResponse(item))
}

func (h *Handler) AdminStatus(c *gin.Context) {
	if h.service == nil {
		response.ErrorFrom(c, http.StatusServiceUnavailable, errUnavailable)
		return
	}
	stats := h.service.Stats(c.Request.Context())
	response.Success(c, adminStatusResponse{
		Configured: stats.Configured, Enabled: stats.Enabled, Healthy: stats.Healthy,
		ActiveSSE: stats.ActiveSSE, VoceRequests: stats.VoceRequests, VoceFailures: stats.VoceFailures,
		IndexFailures: stats.IndexFailures, PendingIndexRepairs: stats.PendingIndexRepairs,
		AverageLatencyMS: stats.AverageLatencyMS, IndexedMessages: stats.IndexedMessages, FileBytes: stats.FileBytes,
	})
}

func (h *Handler) writeAudit(c *gin.Context, action string, mid int64, detail any) {
	if h.audit == nil {
		return
	}
	h.audit.Write(c.Request.Context(), appaudit.WriteInput{
		RequestID: middleware.MustRequestID(c), ActorUserID: middleware.MustUserID(c),
		Action: action, Resource: "internal_message", ResourceID: strconv.FormatInt(mid, 10),
		IP: c.ClientIP(), UserAgent: c.Request.UserAgent(), Detail: detail,
	})
}

func (h *Handler) DownloadFile(c *gin.Context) {
	thumbnail := c.Query("thumbnail") == "true"
	upstream, file, err := h.service.DownloadFile(c.Request.Context(), middleware.MustUserID(c), parseMID(c), thumbnail)
	if err != nil {
		writeError(c, err)
		return
	}
	defer upstream.Body.Close()
	contentType := upstream.Header.Get("Content-Type")
	if contentType == "" {
		contentType = file.ContentType
	}
	disposition := "attachment"
	if file.Image && c.Query("download") != "true" {
		disposition = "inline"
	}
	headers := map[string]string{
		"Cache-Control":          "private, max-age=3600",
		"Content-Disposition":    mime.FormatMediaType(disposition, map[string]string{"filename": file.Name}),
		"X-Content-Type-Options": "nosniff",
	}
	c.DataFromReader(upstream.StatusCode, upstream.ContentLength, contentType, upstream.Body, headers)
}

func parseMID(c *gin.Context) int64 {
	mid, _ := strconv.ParseInt(c.Param("mid"), 10, 64)
	return mid
}

// Events proxies VoceChat SSE through the authenticated DEEIX API. This keeps
// the Voce token and its query-string based SSE protocol off the browser.
func (h *Handler) Events(c *gin.Context) {
	after, _ := strconv.ParseInt(c.Query("after"), 10, 64)
	actorID := middleware.MustUserID(c)
	upstream, err := h.service.Events(c.Request.Context(), actorID, after)
	if err != nil {
		writeError(c, err)
		return
	}
	defer upstream.Body.Close()
	c.Header("Content-Type", "text/event-stream")
	c.Header("X-Accel-Buffering", "no")
	c.Header("Cache-Control", "no-cache, no-transform")
	c.Header("Connection", "keep-alive")
	c.Status(http.StatusOK)
	reader := bufio.NewReader(upstream.Body)
	for {
		line, readErr := reader.ReadString('\n')
		if line != "" {
			line = h.enrichEventLine(c.Request.Context(), actorID, line)
			// Close without acknowledging the failed event. The browser resumes
			// from its last successfully enriched MID once the index recovers.
			if line == "" {
				return
			}
			if _, err := c.Writer.WriteString(line); err != nil {
				return
			}
			c.Writer.Flush()
		}
		if readErr != nil {
			return
		}
	}
}

func (h *Handler) enrichEventLine(ctx context.Context, actorID uint, line string) string {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "data:") {
		return line
	}
	raw := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
	var header struct {
		Type    string `json:"type"`
		FromUID int64  `json:"from_uid"`
	}
	if json.Unmarshal([]byte(raw), &header) != nil {
		return line
	}
	if header.Type == "users_state" || header.Type == "users_state_changed" {
		presence, err := h.service.EventPresence(ctx, raw)
		if err != nil {
			return "data: {\"type\":\"" + header.Type + "\",\"users\":[]}\n"
		}
		return encodePresenceEvent(header.Type, presence)
	}
	if header.Type != "chat" || header.FromUID <= 0 {
		return line
	}
	publicID, err := h.service.ProcessEvent(ctx, raw)
	if err != nil || publicID == "" {
		return ""
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &payload) != nil {
		return line
	}
	publicIDJSON, err := json.Marshal(publicID)
	if err != nil {
		return line
	}
	payload["fromUserPublicID"] = publicIDJSON
	sanitizeEventForBrowser(payload)
	if mid := canonicalEventMID(payload); mid > 0 {
		if message, conversationPublicID, messageErr := h.service.EventMessage(ctx, actorID, mid); messageErr == nil {
			if encodedMessage, marshalErr := json.Marshal(toMessageResponse(message)); marshalErr == nil {
				payload["message"] = encodedMessage
			}
			if encodedConversation, marshalErr := json.Marshal(conversationPublicID); marshalErr == nil {
				payload["conversationPublicID"] = encodedConversation
			}
		}
	}
	enriched, err := json.Marshal(payload)
	if err != nil {
		return line
	}
	return "data: " + string(enriched) + "\n"
}

func encodePresenceEvent(eventType string, presence []app.PresenceUser) string {
	type browserPresence struct {
		PublicID string `json:"publicID"`
		Online   bool   `json:"online"`
	}
	users := make([]browserPresence, 0, len(presence))
	for _, item := range presence {
		users = append(users, browserPresence{PublicID: item.PublicID, Online: item.Online})
	}
	encoded, err := json.Marshal(struct {
		Type  string            `json:"type"`
		Users []browserPresence `json:"users"`
	}{Type: eventType, Users: users})
	if err != nil {
		return "data: {\"type\":\"" + eventType + "\",\"users\":[]}\n"
	}
	return "data: " + string(encoded) + "\n"
}

func canonicalEventMID(payload map[string]json.RawMessage) int64 {
	var mid int64
	_ = json.Unmarshal(payload["mid"], &mid)
	var detail struct {
		Type string `json:"type"`
		MID  int64  `json:"mid"`
	}
	if json.Unmarshal(payload["detail"], &detail) == nil && detail.Type == "reaction" {
		return detail.MID
	}
	return mid
}

// sanitizeEventForBrowser removes VoceChat-only resource identifiers after
// ProcessEvent has persisted the full upstream event. File contents are served
// exclusively through the authenticated DEEIX download endpoint, so the
// browser never needs the private VoceChat file path carried in detail.content.
func sanitizeEventForBrowser(payload map[string]json.RawMessage) {
	raw, ok := payload["detail"]
	if !ok {
		return
	}
	var detail map[string]json.RawMessage
	if json.Unmarshal(raw, &detail) != nil {
		return
	}
	var contentType string
	if json.Unmarshal(detail["content_type"], &contentType) != nil || contentType != "vocechat/file" {
		return
	}
	detail["content"] = json.RawMessage(`""`)
	if encoded, err := json.Marshal(detail); err == nil {
		payload["detail"] = encoded
	}
}

func toMessageResponses(items []app.ChatMessage) []messageResponse {
	results := make([]messageResponse, 0, len(items))
	for _, item := range items {
		results = append(results, toMessageResponse(item))
	}
	return results
}
func toMessageResponse(item app.ChatMessage) messageResponse {
	result := messageResponse{ID: item.ID, FromUserPublicID: item.FromUserPublicID, ContentType: item.ContentType, Content: item.Content, ReplyToID: item.ReplyToID, CreatedAt: item.CreatedAt, EditedAt: item.EditedAt, Deleted: item.Deleted}
	if item.File != nil {
		result.File = &fileResponse{Name: item.File.Name, ContentType: item.File.ContentType, Size: item.File.Size, Image: item.File.Image, Width: item.File.Width, Height: item.File.Height}
	}
	return result
}
func toMessagePageResponse(page app.MessagePage) messagePageResponse {
	return messagePageResponse{Results: toMessageResponses(page.Results), HasMore: page.HasMore, NextBefore: page.NextBefore}
}
func writeError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, app.ErrDisabled):
		response.ErrorFrom(c, http.StatusServiceUnavailable, err)
	case errors.Is(err, app.ErrRecipientUnavailable):
		response.ErrorFrom(c, http.StatusForbidden, err)
	case errors.Is(err, app.ErrMessageUnavailable):
		response.ErrorFrom(c, http.StatusNotFound, err)
	case errors.Is(err, app.ErrFileTooLarge):
		response.ErrorFrom(c, http.StatusRequestEntityTooLarge, err)
	case errors.Is(err, app.ErrQuotaExceeded):
		response.ErrorFrom(c, http.StatusConflict, err)
	default:
		response.ErrorFrom(c, http.StatusBadGateway, errUnavailable)
	}
}
