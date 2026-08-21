package internalmessaging

import (
	"context"

	domainmessaging "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/internalmessaging"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"gorm.io/gorm"
)

type Repo struct{ db *gorm.DB }

func NewRepo(db *gorm.DB) *Repo { return &Repo{db: db} }

func (r *Repo) Upsert(ctx context.Context, item domainmessaging.Binding) error {
	modelItem := model.InternalMessagingBinding{UserID: item.UserID, UserPublicID: item.UserPublicID, VoceUID: item.VoceUID, SyncedName: item.SyncedName, SyncedAt: item.SyncedAt}
	return r.db.WithContext(ctx).Where("user_id = ?", item.UserID).Assign(modelItem).FirstOrCreate(&modelItem).Error
}

func (r *Repo) FindByUserID(ctx context.Context, userID uint) (*domainmessaging.Binding, error) {
	var item model.InternalMessagingBinding
	if err := r.db.WithContext(ctx).Where("user_id = ?", userID).First(&item).Error; err != nil {
		return nil, err
	}
	return &domainmessaging.Binding{UserID: item.UserID, UserPublicID: item.UserPublicID, VoceUID: item.VoceUID, SyncedName: item.SyncedName, SyncedAt: item.SyncedAt}, nil
}

func (r *Repo) FindByVoceUID(ctx context.Context, voceUID int64) (*domainmessaging.Binding, error) {
	var item model.InternalMessagingBinding
	if err := r.db.WithContext(ctx).Where("voce_uid = ?", voceUID).First(&item).Error; err != nil {
		return nil, err
	}
	return &domainmessaging.Binding{UserID: item.UserID, UserPublicID: item.UserPublicID, VoceUID: item.VoceUID, SyncedName: item.SyncedName, SyncedAt: item.SyncedAt}, nil
}
