package internalmessaging

import (
	"context"
	domain "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/internalmessaging"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"time"
)

func (r *Repo) BeginIndexRepair(ctx context.Context, actorID, peerID uint, readyAt time.Time) (uint, error) {
	var latest int64
	if err := r.db.WithContext(ctx).Model(&model.InternalMessagingMessage{}).
		Where("(sender_user_id = ? AND recipient_user_id = ?) OR (sender_user_id = ? AND recipient_user_id = ?)", actorID, peerID, peerID, actorID).
		Select("COALESCE(MAX(mid), 0)").Scan(&latest).Error; err != nil {
		return 0, err
	}
	item := model.InternalMessagingIndexRepair{ActorID: actorID, PeerID: peerID, AfterMID: latest, EventsJSON: "[]", ReadyAt: readyAt}
	err := r.db.WithContext(ctx).Create(&item).Error
	return item.ID, err
}

func (r *Repo) ListIndexRepairs(ctx context.Context, now time.Time, limit int) ([]domain.IndexRepair, error) {
	var rows []model.InternalMessagingIndexRepair
	if err := r.db.WithContext(ctx).Where("ready_at <= ?", now).Order("ready_at, id").Limit(limit).Find(&rows).Error; err != nil {
		return nil, err
	}
	items := make([]domain.IndexRepair, 0, len(rows))
	for _, row := range rows {
		items = append(items, domain.IndexRepair{ID: row.ID, ActorID: row.ActorID, PeerID: row.PeerID, AfterMID: row.AfterMID, BeforeMID: row.BeforeMID, EventsJSON: row.EventsJSON, ReadyAt: row.ReadyAt})
	}
	return items, nil
}

func (r *Repo) SaveIndexRepair(ctx context.Context, item domain.IndexRepair) error {
	return r.db.WithContext(ctx).Model(&model.InternalMessagingIndexRepair{}).Where("id = ?", item.ID).
		Updates(map[string]any{"before_mid": item.BeforeMID, "events_json": item.EventsJSON, "ready_at": item.ReadyAt}).Error
}

func (r *Repo) CompleteIndexRepair(ctx context.Context, id uint) error {
	return r.db.WithContext(ctx).Delete(&model.InternalMessagingIndexRepair{}, id).Error
}

func (r *Repo) PendingIndexRepairs(ctx context.Context) (int64, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&model.InternalMessagingIndexRepair{}).Count(&count).Error
	return count, err
}
