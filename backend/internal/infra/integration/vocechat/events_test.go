package vocechat

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// Model VoceChat's one-stream-per-device rule rather than a generic SSE server.
type eventTestServer struct {
	mu      sync.Mutex
	devices map[string]bool
	streams map[string]chan string
	after   []string
	logouts int
	fail    bool
}

func (s *eventTestServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/token/create_third_party_key":
		_ = json.NewEncoder(w).Encode("short-key")
	case "/api/token/login":
		var body struct {
			Device string `json:"device"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		s.mu.Lock()
		s.devices[body.Device] = true
		s.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"token": body.Device, "user": map[string]int64{"uid": 1}})
	case "/api/user/events":
		device := r.URL.Query().Get("api-key")
		s.mu.Lock()
		if s.fail {
			s.mu.Unlock()
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		if old := s.streams[device]; old != nil {
			close(old)
		}
		stream := make(chan string, 4)
		s.streams[device] = stream
		s.after = append(s.after, r.URL.Query().Get("after_mid"))
		s.mu.Unlock()
		defer func() {
			s.mu.Lock()
			if s.streams[device] == stream {
				delete(s.streams, device)
			}
			s.mu.Unlock()
		}()
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"ready\"}\n\n")
		w.(http.Flusher).Flush()
		for {
			select {
			case frame, ok := <-stream:
				if !ok {
					return
				}
				_, _ = fmt.Fprint(w, frame)
				w.(http.Flusher).Flush()
			case <-r.Context().Done():
				return
			}
		}
	case "/api/token/logout":
		s.mu.Lock()
		device := r.Header.Get("X-API-Key")
		delete(s.devices, device)
		if stream := s.streams[device]; stream != nil {
			delete(s.streams, device)
			close(stream)
		}
		s.logouts++
		s.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	default:
		http.NotFound(w, r)
	}
}

func (s *eventTestServer) broadcast(frame string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, stream := range s.streams {
		stream <- frame
	}
}

func readEventFrame(t *testing.T, reader *bufio.Reader) string {
	t.Helper()
	var frame strings.Builder
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("stream ended before the next event: %v", err)
		}
		frame.WriteString(line)
		if line == "\n" {
			return frame.String()
		}
	}
}

func TestEventsIsolateSameUserStreamsAndCleanUpDevices(t *testing.T) {
	state := &eventTestServer{devices: make(map[string]bool), streams: make(map[string]chan string)}
	server := httptest.NewServer(state)
	defer server.Close()
	client := New(server.URL, "secret", time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	regular, err := client.LoginAs(ctx, "actor", "Actor")
	if err != nil {
		t.Fatal(err)
	}
	first, err := client.Events(ctx, "actor", "Actor", 42)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Body.Close()
	firstReader := bufio.NewReader(first.Body)
	readEventFrame(t, firstReader)
	second, err := client.Events(ctx, "actor", "Actor", 99)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Body.Close()
	secondReader := bufio.NewReader(second.Body)
	readEventFrame(t, secondReader)

	frame := "data: {\"type\":\"chat\",\"mid\":100}\n\n"
	state.broadcast(frame)
	if got := readEventFrame(t, firstReader); got != frame {
		t.Fatalf("first stream got %q", got)
	}
	if got := readEventFrame(t, secondReader); got != frame {
		t.Fatalf("second stream got %q", got)
	}
	_ = first.Body.Close()
	_ = first.Body.Close()
	state.broadcast(frame)
	if got := readEventFrame(t, secondReader); got != frame {
		t.Fatalf("closing the first stream disrupted the second: %q", got)
	}
	// Cleanup must still reach VoceChat after the browser's context is canceled.
	cancel()
	_ = second.Body.Close()
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.logouts != 2 || len(state.devices) != 1 || !state.devices[regular.Token] {
		t.Fatalf("temporary devices not cleaned up independently: logouts=%d devices=%v", state.logouts, state.devices)
	}
	if got := strings.Join(state.after, ","); got != "42,99" {
		t.Fatalf("resume cursors = %q, want 42,99", got)
	}
}

func TestEventsCleanUpDeviceWhenUpstreamRejectsStream(t *testing.T) {
	state := &eventTestServer{devices: make(map[string]bool), streams: make(map[string]chan string), fail: true}
	server := httptest.NewServer(state)
	defer server.Close()
	response, err := New(server.URL, "secret", time.Second).Events(context.Background(), "actor", "Actor", 42)
	if err == nil || response != nil {
		t.Fatalf("response=%v err=%v, want an upstream failure", response, err)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.devices) != 0 || state.logouts != 1 {
		t.Fatalf("failed connection leaked a device: devices=%v logouts=%d", state.devices, state.logouts)
	}
}
