// Package internalmessaging contains domain values for the optional DEEIX
// direct-message integration.
package internalmessaging

import "time"

// Binding permanently links one DEEIX user to its opaque VoceChat identity.
// It intentionally has no persistence or HTTP representation.
type Binding struct {
	UserID       uint
	UserPublicID string
	VoceUID      int64
	SyncedName   string
	SyncedAt     time.Time
}

// MessageIndex mirrors the product-visible metadata of a VoceChat message.
// VoceChat remains the source of truth for delivery and history; this index
// powers durable unread counts, recent conversations and bounded search.
type MessageIndex struct {
	MID             int64
	SenderUserID    uint
	RecipientUserID uint
	ContentType     string
	Content         string
	MetadataJSON    string
	FileSize        int64
	ReplyToMID      int64
	SentAt          time.Time
	EditedAt        time.Time
	LastEventMID    int64
	Deleted         bool
}

// ConversationState is directional: each participant owns an independent
// read position, unread count, pin and mute preference for the same peer.
type ConversationState struct {
	UserID             uint
	PeerUserID         uint
	LastMessageMID     int64
	LastMessagePreview string
	LastMessageAt      time.Time
	UnreadCount        int64
	ReadThroughMID     int64
	Pinned             bool
	Muted              bool
}

// IndexRepair is written before a remote mutation. If local indexing fails or
// the process exits, history after AfterMID can rebuild the missing index.
type IndexRepair struct {
	ID         uint
	ActorID    uint
	PeerID     uint
	AfterMID   int64
	BeforeMID  int64
	EventsJSON string
	ReadyAt    time.Time
}
