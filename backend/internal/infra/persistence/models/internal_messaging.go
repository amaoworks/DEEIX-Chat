package model

import "time"

// InternalMessagingBinding permanently connects a DEEIX identity with its
// VoceChat user. The public identifier is stored to make cross-service IDs
// opaque to browser clients.
type InternalMessagingBinding struct {
	BaseModel
	UserID       uint      `gorm:"not null;uniqueIndex:idx_internal_messaging_bindings_user_id"`
	UserPublicID string    `gorm:"size:32;not null;uniqueIndex:idx_internal_messaging_bindings_public_id"`
	VoceUID      int64     `gorm:"not null;uniqueIndex:idx_internal_messaging_bindings_voce_uid"`
	SyncedName   string    `gorm:"size:128;not null;default:''"`
	SyncedAt     time.Time `gorm:"not null"`
}

func (InternalMessagingBinding) TableName() string { return "internal_messaging_bindings" }

// InternalMessagingMessage is a searchable metadata mirror. Message delivery
// and canonical history stay in VoceChat.
type InternalMessagingMessage struct {
	BaseModel
	MID             int64     `gorm:"column:mid;not null;uniqueIndex:idx_internal_messaging_messages_mid"`
	SenderUserID    uint      `gorm:"not null;index:idx_internal_messaging_messages_sender"`
	RecipientUserID uint      `gorm:"not null;index:idx_internal_messaging_messages_recipient"`
	ContentType     string    `gorm:"size:64;not null;default:'text/plain'"`
	Content         string    `gorm:"type:text;not null"`
	MetadataJSON    string    `gorm:"type:text;not null;default:'{}'"`
	FileSize        int64     `gorm:"not null;default:0"`
	ReplyToMID      int64     `gorm:"column:reply_to_mid;not null;default:0;index:idx_internal_messaging_messages_reply"`
	SentAt          time.Time `gorm:"not null;index:idx_internal_messaging_messages_sent_at"`
	EditedAt        time.Time
	MessageDeleted  bool `gorm:"not null;default:false;index:idx_internal_messaging_messages_deleted"`
}

func (InternalMessagingMessage) TableName() string { return "internal_messaging_messages" }

// InternalMessagingConversation stores per-user state for one direct-message
// peer. The composite key keeps read and preference state independent.
type InternalMessagingConversation struct {
	BaseModel
	UserID             uint      `gorm:"not null;uniqueIndex:idx_internal_messaging_conversations_owner_peer;index:idx_internal_messaging_conversations_owner_activity,priority:1"`
	PeerUserID         uint      `gorm:"not null;uniqueIndex:idx_internal_messaging_conversations_owner_peer"`
	LastMessageMID     int64     `gorm:"column:last_message_mid;not null;default:0"`
	LastMessagePreview string    `gorm:"size:512;not null;default:''"`
	LastMessageAt      time.Time `gorm:"index:idx_internal_messaging_conversations_owner_activity,priority:3,sort:desc"`
	UnreadCount        int64     `gorm:"not null;default:0"`
	ReadThroughMID     int64     `gorm:"column:read_through_mid;not null;default:0"`
	Pinned             bool      `gorm:"not null;default:false;index:idx_internal_messaging_conversations_owner_activity,priority:2,sort:desc"`
	Muted              bool      `gorm:"not null;default:false"`
}

func (InternalMessagingConversation) TableName() string {
	return "internal_messaging_conversations"
}
