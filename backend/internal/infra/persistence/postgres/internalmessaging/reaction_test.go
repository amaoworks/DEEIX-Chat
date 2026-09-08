package internalmessaging

import (
	"context"
	domain "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/internalmessaging"
	"testing"
	"time"
)

func TestReactionReplayCannotOverwriteNewerEditOrDoubleDecrementUnread(t *testing.T) {
	r := newTestRepo(t)
	ctx := context.Background()
	if _, err := r.RecordMessage(ctx, domain.MessageIndex{MID: 1, SenderUserID: 1, RecipientUserID: 2, Content: "original", SentAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	for _, event := range []struct {
		id      int64
		text    string
		deleted bool
	}{
		{5, "newest edit", false}, {3, "stale edit", false}, {5, "newest edit", false},
	} {
		if err := r.ApplyReaction(ctx, 1, 1, event.id, "text/plain", event.text, "{}", event.deleted); err != nil {
			t.Fatal(err)
		}
	}
	item, _ := r.FindMessage(ctx, 1, 1)
	if item.Content != "newest edit" {
		t.Fatalf("stale replay won: %q", item.Content)
	}
	if err := r.ApplyReaction(ctx, 1, 1, 6, "text/plain", "", "{}", true); err != nil {
		t.Fatal(err)
	}
	if err := r.ApplyReaction(ctx, 1, 1, 6, "text/plain", "", "{}", true); err != nil {
		t.Fatal(err)
	}
	if err := r.ApplyReaction(ctx, 1, 1, 4, "text/plain", "resurrect", "{}", false); err != nil {
		t.Fatal(err)
	}
	item, _ = r.FindMessage(ctx, 1, 1)
	if !item.Deleted || item.Content != "" {
		t.Fatalf("deleted message resurrected: %+v", item)
	}
	if unread, _ := r.TotalUnread(ctx, 2); unread != 0 {
		t.Fatalf("unread=%d", unread)
	}
}
