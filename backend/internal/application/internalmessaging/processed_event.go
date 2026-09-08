package internalmessaging

import (
	"context"
	"encoding/json"
	"strconv"
	"time"
)

type processedEvent struct {
	publicID string
	expires  time.Time
}

// Each tab/device receives the same upstream event. Coalesce its indexing work
// per application instance; per-actor authorization remains in EventMessage.
func (s *Service) ProcessEvent(ctx context.Context, raw string) (string, error) {
	var header struct {
		Type string `json:"type"`
		MID  int64  `json:"mid"`
	}
	if err := json.Unmarshal([]byte(raw), &header); err != nil {
		return "", err
	}
	if header.Type != "chat" || header.MID <= 0 {
		return s.processEvent(ctx, raw)
	}
	result, err, _ := s.eventWork.Do(strconv.FormatInt(header.MID, 10), func() (any, error) {
		now := time.Now()
		s.eventMu.Lock()
		cached, exists := s.processedEvents[header.MID]
		s.eventMu.Unlock()
		if exists && now.Before(cached.expires) {
			return cached.publicID, nil
		}
		publicID, err := s.processEvent(ctx, raw)
		if err != nil {
			return "", err
		}
		s.eventMu.Lock()
		defer s.eventMu.Unlock()
		if s.processedEvents == nil {
			s.processedEvents = make(map[int64]processedEvent)
		}
		for mid, event := range s.processedEvents {
			if !now.Before(event.expires) {
				delete(s.processedEvents, mid)
			}
		}
		if len(s.processedEvents) >= 1024 {
			var oldest int64
			var expires time.Time
			for mid, event := range s.processedEvents {
				if oldest == 0 || event.expires.Before(expires) {
					oldest, expires = mid, event.expires
				}
			}
			delete(s.processedEvents, oldest)
		}
		s.processedEvents[header.MID] = processedEvent{publicID: publicID, expires: now.Add(30 * time.Second)}
		return publicID, nil
	})
	if err != nil {
		return "", err
	}
	return result.(string), nil
}
