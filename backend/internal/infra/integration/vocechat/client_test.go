package vocechat

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLoginAsCreatesAndExchangesPrivateKey(t *testing.T) {
	var sawSecret bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/token/create_third_party_key":
			sawSecret = r.Header.Get("X-SECRET") == "server-only-secret"
			_ = json.NewEncoder(w).Encode("short-key")
		case "/api/token/login":
			var body map[string]interface{}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			credential := body["credential"].(map[string]interface{})
			if credential["type"] != "thirdparty" || credential["key"] != "short-key" {
				t.Fatalf("unexpected credential: %#v", credential)
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"token": "access-token", "user": map[string]int64{"uid": 12}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	login, err := New(server.URL, "server-only-secret", time.Second).LoginAs(context.Background(), "deeix-user-id", "Deeix User")
	if err != nil {
		t.Fatal(err)
	}
	if !sawSecret || login.Token != "access-token" || login.User.UID != 12 {
		t.Fatalf("unexpected login: %#v, secret=%t", login, sawSecret)
	}
}

func TestSendUsesPlainTextAndPrivateToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/user/42/send" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("X-API-Key") != "private-token" {
			t.Fatal("missing private token")
		}
		if r.Header.Get("Content-Type") != "text/plain" {
			t.Fatalf("unexpected content type: %s", r.Header.Get("Content-Type"))
		}
		_ = json.NewEncoder(w).Encode(int64(99))
	}))
	defer server.Close()

	mid, err := New(server.URL, "unused", time.Second).Send(context.Background(), "private-token", 42, "hello")
	if err != nil {
		t.Fatal(err)
	}
	if mid != 99 {
		t.Fatalf("mid = %d, want 99", mid)
	}
}

func TestHistoryNormalizesCurrentVoceChatMillisecondTimestamps(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/user/42/history" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`[{"mid":9,"from_uid":7,"created_at":1787230736974,"detail":{"type":"normal","content":"hello"}}]`))
	}))
	defer server.Close()

	messages, err := New(server.URL, "unused", time.Second).History(context.Background(), "private-token", 42, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := messages[0].CreatedAtRFC3339(), "2026-08-20T12:58:56.974Z"; got != want {
		t.Fatalf("created at = %q, want %q", got, want)
	}
}
