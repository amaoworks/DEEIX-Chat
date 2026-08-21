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
