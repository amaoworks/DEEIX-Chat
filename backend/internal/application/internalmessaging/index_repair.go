package internalmessaging

import (
	"context"
	"encoding/json"
	"fmt"
	domain "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/internalmessaging"
	vocechat "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/vocechat"
	"log/slog"
	"time"
)

type indexRepairStore interface {
	BeginIndexRepair(context.Context, uint, uint, time.Time) (uint, error)
	ListIndexRepairs(context.Context, time.Time, int) ([]domain.IndexRepair, error)
	SaveIndexRepair(context.Context, domain.IndexRepair) error
	CompleteIndexRepair(context.Context, uint) error
	PendingIndexRepairs(context.Context) (int64, error)
}

func (s *Service) beginIndexRepair(ctx context.Context, actorID, peerID uint) (uint, error) {
	if s.conversations == nil {
		return 0, nil
	}
	store, ok := s.conversations.(indexRepairStore)
	if !ok {
		return 0, fmt.Errorf("message index recovery is unavailable")
	}
	// Remote mutations have a one-minute context deadline. Repair must not race
	// an in-flight request, including one owned by another application instance.
	return store.BeginIndexRepair(ctx, actorID, peerID, time.Now().Add(2*time.Minute))
}

func (s *Service) finishIndexRepair(ctx context.Context, id uint, indexErr error) {
	if indexErr != nil {
		s.observeIndexError(indexErr)
		return
	}
	if id == 0 {
		return
	}
	store, ok := s.conversations.(indexRepairStore)
	if !ok {
		return
	}
	if err := store.CompleteIndexRepair(ctx, id); err != nil {
		s.observeIndexError(err)
	}
}

func (s *Service) observeIndexError(err error) {
	if err == nil {
		return
	}
	s.indexFailures.Add(1)
	// Never log message bodies, tokens, or SQL error text (which can include a body).
	slog.Warn("internal messaging index update failed; reconciliation required")
}

func (s *Service) repairIndexes(ctx context.Context) {
	store, ok := s.conversations.(indexRepairStore)
	if !ok || !s.Enabled() {
		return
	}
	items, err := store.ListIndexRepairs(ctx, time.Now(), 20)
	if err != nil {
		s.observeIndexError(err)
		return
	}
	for _, item := range items {
		if ctx.Err() != nil {
			return
		}
		attemptCtx, cancel := context.WithTimeout(ctx, time.Minute)
		err = s.repairIndex(attemptCtx, store, item)
		cancel()
		if err != nil {
			s.observeIndexError(err)
			item.ReadyAt = time.Now().Add(time.Minute)
			// Preserve the last durable cursor after a failed attempt.
			if saveErr := store.SaveIndexRepair(ctx, item); saveErr != nil {
				s.observeIndexError(saveErr)
			}
		}
	}
}

func (s *Service) repairIndex(ctx context.Context, store indexRepairStore, item domain.IndexRepair) error {
	actor, err := s.users.GetByID(ctx, item.ActorID)
	if err != nil {
		return err
	}
	peer, err := s.users.GetByID(ctx, item.PeerID)
	if err != nil {
		return err
	}
	if actor == nil || peer == nil {
		return ErrRecipientUnavailable
	}
	// Recovery also works for subsequently deactivated users; this is a private
	// server-side history read, not permission to send on their behalf.
	actorLogin, err := s.loginAndBind(ctx, *actor)
	if err != nil {
		return err
	}
	peerLogin, err := s.resolveTargetLogin(ctx, *peer)
	if err != nil {
		return err
	}
	var events []vocechat.Message
	if err = json.Unmarshal([]byte(item.EventsJSON), &events); err != nil {
		return err
	}
	complete := false
	// Bound each attempt and persist pagination progress, so a busy conversation
	// cannot starve recovery by continually growing past a fixed first-page cap.
	for range 10 {
		started := time.Now()
		page, historyErr := s.voce.History(ctx, actorLogin.Token, peerLogin.User.UID, item.BeforeMID, historyRawFetchLimit)
		s.observeVoce(started, historyErr == nil)
		if historyErr != nil {
			s.loginCache.Delete(actor.ID)
			return historyErr
		}
		next := int64(0)
		for _, event := range page {
			if event.MID <= 0 {
				continue
			}
			if next == 0 || event.MID < next {
				next = event.MID
			}
			if event.MID <= item.AfterMID {
				complete = true
				continue
			}
			events = append(events, event)
		}
		if len(page) < historyRawFetchLimit {
			complete = true
		}
		if complete {
			break
		}
		if next == 0 || (item.BeforeMID > 0 && next >= item.BeforeMID) {
			return fmt.Errorf("history cursor did not advance")
		}
		item.BeforeMID = next
	}
	if complete {
		if err = s.recordVoceMessages(ctx, events, *actor, *peer, actorLogin.User.UID); err != nil {
			return err
		}
		return store.CompleteIndexRepair(ctx, item.ID)
	}
	encoded, err := json.Marshal(events)
	if err != nil {
		return err
	}
	item.EventsJSON = string(encoded)
	item.ReadyAt = time.Now().Add(time.Second)
	return store.SaveIndexRepair(ctx, item)
}
