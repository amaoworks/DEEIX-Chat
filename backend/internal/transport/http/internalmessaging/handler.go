package internalmessaging

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	app "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/internalmessaging"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/response"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/middleware"
	"github.com/gin-gonic/gin"
)

type Handler struct{ service *app.Service }

func NewHandler(service *app.Service) *Handler { return &Handler{service: service} }

type sendRequest struct {
	Content string `json:"content" binding:"required,max=16000"`
}
type statusResponse struct {
	Enabled bool `json:"enabled"`
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
	ID               int64  `json:"id"`
	FromUserPublicID string `json:"fromUserPublicID"`
	Content          string `json:"content"`
	CreatedAt        string `json:"createdAt"`
}

func (h *Handler) Status(c *gin.Context) {
	response.Success(c, statusResponse{Enabled: h.service != nil && h.service.Available(c.Request.Context(), middleware.MustUserID(c))})
}

func (h *Handler) ListUsers(c *gin.Context) {
	if h.service == nil {
		response.Error(c, http.StatusServiceUnavailable, "internal messaging is disabled")
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
	response.Success(c, toMessageResponses(items))
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

// Events proxies VoceChat SSE through the authenticated DEEIX API. This keeps
// the Voce token and its query-string based SSE protocol off the browser.
func (h *Handler) Events(c *gin.Context) {
	after, _ := strconv.ParseInt(c.Query("after"), 10, 64)
	upstream, err := h.service.Events(c.Request.Context(), middleware.MustUserID(c), after)
	if err != nil {
		writeError(c, err)
		return
	}
	defer upstream.Body.Close()
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache, no-transform")
	c.Header("Connection", "keep-alive")
	c.Status(http.StatusOK)
	reader := bufio.NewReader(upstream.Body)
	for {
		line, readErr := reader.ReadString('\n')
		if line != "" {
			line = h.enrichEventLine(c.Request.Context(), line)
			_, _ = c.Writer.WriteString(line)
			c.Writer.Flush()
		}
		if readErr != nil {
			return
		}
	}
}

func (h *Handler) enrichEventLine(ctx context.Context, line string) string {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "data:") {
		return line
	}
	raw := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
	var header struct {
		Type    string `json:"type"`
		FromUID int64  `json:"from_uid"`
	}
	if json.Unmarshal([]byte(raw), &header) != nil || header.Type != "chat" || header.FromUID <= 0 {
		return line
	}
	publicID, err := h.service.EventSenderPublicID(ctx, header.FromUID)
	if err != nil || publicID == "" {
		return line
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
	enriched, err := json.Marshal(payload)
	if err != nil {
		return line
	}
	return "data: " + string(enriched) + "\n"
}

func toMessageResponses(items []app.ChatMessage) []messageResponse {
	results := make([]messageResponse, 0, len(items))
	for _, item := range items {
		results = append(results, toMessageResponse(item))
	}
	return results
}
func toMessageResponse(item app.ChatMessage) messageResponse {
	return messageResponse{ID: item.ID, FromUserPublicID: item.FromUserPublicID, Content: item.Content, CreatedAt: item.CreatedAt}
}
func writeError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, app.ErrDisabled):
		response.Error(c, http.StatusServiceUnavailable, err.Error())
	case errors.Is(err, app.ErrRecipientUnavailable):
		response.Error(c, http.StatusForbidden, err.Error())
	default:
		response.Error(c, http.StatusBadGateway, "internal messaging unavailable")
	}
}
