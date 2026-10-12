package internalmessaging

import "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/apperr"

var (
	ErrDisabled             = apperr.New("internal_messaging.disabled", "internal messaging is disabled")
	ErrRecipientUnavailable = apperr.New("internal_messaging.recipient_unavailable", "recipient is unavailable")
	ErrMessageUnavailable   = apperr.New("internal_messaging.message_unavailable", "message is unavailable")
	ErrFileTooLarge         = apperr.New("internal_messaging.file_too_large", "file exceeds the configured size limit")
	ErrQuotaExceeded        = apperr.New("internal_messaging.quota_exceeded", "file quota exceeded")
)
