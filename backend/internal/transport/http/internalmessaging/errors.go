package internalmessaging

import "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/apperr"

var errUnavailable = apperr.New("internal_messaging.unavailable", "internal messaging is unavailable")
