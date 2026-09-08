package internalmessaging

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	appaudit "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/audit"
	app "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/internalmessaging"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/response"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/middleware"
	"github.com/gin-gonic/gin"
)

func TestMessagingErrorsPreserveStatusAndUseTypedEnvelope(t *testing.T) {
	for _, test := range []struct {
		err    error
		status int
		code   string
	}{
		{app.ErrDisabled, http.StatusServiceUnavailable, "disabled"},
		{app.ErrRecipientUnavailable, http.StatusForbidden, "recipient_unavailable"},
		{app.ErrMessageUnavailable, http.StatusNotFound, "message_unavailable"},
		{app.ErrFileTooLarge, http.StatusRequestEntityTooLarge, "file_too_large"},
		{app.ErrQuotaExceeded, http.StatusConflict, "quota_exceeded"},
		{errors.New("private upstream credentials"), http.StatusBadGateway, "unavailable"},
	} {
		t.Run(test.code, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Set(middleware.ContextKeyRequestID, "request-123")
			writeError(c, fmt.Errorf("wrapped: %w", test.err))
			var body response.Envelope
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if recorder.Code != test.status || body.ErrorCode != "internal_messaging."+test.code || body.RequestID != "request-123" {
				t.Fatalf("unexpected error response: status=%d body=%+v", recorder.Code, body)
			}
			if test.code == "unavailable" && body.ErrorMsg != "internal messaging is unavailable" {
				t.Fatalf("unexpected fallback message: %q", body.ErrorMsg)
			}
		})
	}
}

type capturingAuditWriter struct{ input appaudit.WriteInput }

func (w *capturingAuditWriter) Write(_ context.Context, input appaudit.WriteInput) { w.input = input }

func TestMessagingAuditPreservesMetadata(t *testing.T) {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/", nil)
	c.Request.RemoteAddr = "192.0.2.1:1234"
	c.Request.Header.Set("User-Agent", "messaging-test")
	c.Set(middleware.ContextKeyUserID, uint(42))
	c.Set(middleware.ContextKeyRequestID, "request-123")
	writer := &capturingAuditWriter{}
	h := NewHandler(nil)
	h.SetAuditWriter(writer)
	detail := map[string]any{"name": "example.txt", "size": 42}
	h.writeAudit(c, "internal_message_file_send", 99, detail)
	want := appaudit.WriteInput{
		RequestID: "request-123", ActorUserID: 42, Action: "internal_message_file_send",
		Resource: "internal_message", ResourceID: "99", IP: "192.0.2.1", UserAgent: "messaging-test", Detail: detail,
	}
	if !reflect.DeepEqual(writer.input, want) {
		t.Fatalf("audit metadata changed: got %+v, want %+v", writer.input, want)
	}
}
