package internalmessaging

import (
	"encoding/json"
	"strings"
	"testing"
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

func decodeEventPayload(t *testing.T, raw string) map[string]json.RawMessage {
	t.Helper()
	var payload map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}
