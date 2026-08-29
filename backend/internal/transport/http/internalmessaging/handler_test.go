package internalmessaging

import (
	"encoding/json"
	"strings"
	"testing"

	app "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/internalmessaging"
)

func TestSanitizeEventForBrowserRemovesVoceFilePath(t *testing.T) {
	payload := decodeEventPayload(t, `{
		"type":"chat",
		"mid":12,
		"detail":{
			"type":"normal",
			"content_type":"vocechat/file",
			"content":"2026/8/21/private-file-id",
			"properties":{"name":"pixel.png"}
		}
	}`)

	sanitizeEventForBrowser(payload)
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "private-file-id") {
		t.Fatalf("sanitized event still exposes VoceChat path: %s", encoded)
	}

	var detail struct {
		ContentType string                     `json:"content_type"`
		Content     string                     `json:"content"`
		Properties  map[string]json.RawMessage `json:"properties"`
	}
	if err := json.Unmarshal(payload["detail"], &detail); err != nil {
		t.Fatal(err)
	}
	if detail.ContentType != "vocechat/file" || detail.Content != "" || string(detail.Properties["name"]) != `"pixel.png"` {
		t.Fatalf("unexpected sanitized detail: %+v", detail)
	}
}

func TestSanitizeEventForBrowserPreservesTextContent(t *testing.T) {
	payload := decodeEventPayload(t, `{"type":"chat","detail":{"type":"normal","content_type":"text/plain","content":"hello"}}`)
	sanitizeEventForBrowser(payload)
	if !strings.Contains(string(payload["detail"]), `"content":"hello"`) {
		t.Fatalf("text event was modified: %s", payload["detail"])
	}
}

func TestCanonicalEventMID(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want int64
	}{
		{name: "normal", raw: `{"type":"chat","mid":321,"detail":{"type":"normal"}}`, want: 321},
		{name: "reply", raw: `{"type":"chat","mid":322,"detail":{"type":"reply","mid":321}}`, want: 322},
		{name: "edit reaction", raw: `{"type":"chat","mid":400,"detail":{"type":"reaction","mid":321,"detail":{"type":"edit"}}}`, want: 321},
		{name: "delete reaction", raw: `{"type":"chat","mid":401,"detail":{"type":"reaction","mid":321,"detail":{"type":"delete"}}}`, want: 321},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := canonicalEventMID(decodeEventPayload(t, test.raw)); got != test.want {
				t.Fatalf("canonicalEventMID()=%d, want %d", got, test.want)
			}
		})
	}
}

func TestEncodePresenceEventExposesOnlyDEEIXIdentity(t *testing.T) {
	line := encodePresenceEvent("users_state_changed", []app.PresenceUser{{PublicID: "opaque-user", Online: true}})
	if !strings.Contains(line, `"publicID":"opaque-user"`) || !strings.Contains(line, `"online":true`) {
		t.Fatalf("unexpected presence event: %s", line)
	}
	for _, private := range []string{"uid", "voce", "api-key"} {
		if strings.Contains(strings.ToLower(line), private) {
			t.Fatalf("presence event exposed private field %q: %s", private, line)
		}
	}
}

func decodeEventPayload(t *testing.T, raw string) map[string]json.RawMessage {
	t.Helper()
	var payload map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}
