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
