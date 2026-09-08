package internalmessaging

import (
	"context"
	"strings"
	"time"

	domainmessaging "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/internalmessaging"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
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

// RecordMessage inserts a message once and advances both participants' recent
// conversation state atomically. Duplicate SSE delivery is intentionally a
// no-op so unread counts cannot drift during reconnects.
func (r *Repo) RecordMessage(ctx context.Context, item domainmessaging.MessageIndex) (bool, error) {
	created := false
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var err error
		created, err = r.recordMessage(tx, item)
		return err
	})
	return created, err
}

// RecordMessages indexes one history page in a single transaction. Individual
// conflict checks remain idempotent, while SQLite/Postgres no longer pay for a
// transaction boundary per historical message.
func (r *Repo) RecordMessages(ctx context.Context, items []domainmessaging.MessageIndex) error {
	if len(items) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, item := range items {
			if _, err := r.recordMessage(tx, item); err != nil {
				return err
			}
		}
		return nil
	})
}

func (r *Repo) recordMessage(tx *gorm.DB, item domainmessaging.MessageIndex) (bool, error) {
	entity := model.InternalMessagingMessage{
		MID:             item.MID,
		SenderUserID:    item.SenderUserID,
		RecipientUserID: item.RecipientUserID,
		ContentType:     item.ContentType,
		Content:         item.Content,
		MetadataJSON:    item.MetadataJSON,
		FileSize:        item.FileSize,
		ReplyToMID:      item.ReplyToMID,
		SentAt:          item.SentAt,
	}
	result := tx.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "mid"}},
		DoNothing: true,
	}).Create(&entity)
	if result.Error != nil {
		return false, result.Error
	}
	if result.RowsAffected == 0 {
		// A proxied SSE event can win the race against the send response. Let
		// the sender's richer file metadata fill an otherwise empty index row
		// without advancing conversations or unread counts a second time.
		if item.MetadataJSON != "" {
			err := tx.Model(&model.InternalMessagingMessage{}).
				Where("mid = ? AND (metadata_json = '' OR metadata_json = '{}')", item.MID).
				Updates(map[string]any{"metadata_json": item.MetadataJSON, "file_size": item.FileSize}).Error
			return false, err
		}
		return false, nil
	}

	preview := messagePreview(item.Content, item.ContentType)
	if err := r.advanceConversation(tx, item.SenderUserID, item.RecipientUserID, item.MID, preview, item.SentAt, false); err != nil {
		return false, err
	}
	if err := r.advanceConversation(tx, item.RecipientUserID, item.SenderUserID, item.MID, preview, item.SentAt, true); err != nil {
		return false, err
	}
	return true, nil
}

func (r *Repo) advanceConversation(tx *gorm.DB, userID, peerUserID uint, mid int64, preview string, sentAt any, incrementUnread bool) error {
	state := model.InternalMessagingConversation{UserID: userID, PeerUserID: peerUserID}
	if err := tx.Where("user_id = ? AND peer_user_id = ?", userID, peerUserID).FirstOrCreate(&state).Error; err != nil {
		return err
	}
	updates := map[string]any{
		"last_message_mid":     gorm.Expr("CASE WHEN last_message_mid < ? THEN ? ELSE last_message_mid END", mid, mid),
		"last_message_preview": gorm.Expr("CASE WHEN last_message_mid < ? THEN ? ELSE last_message_preview END", mid, preview),
		"last_message_at":      gorm.Expr("CASE WHEN last_message_mid < ? THEN ? ELSE last_message_at END", mid, sentAt),
	}
	if incrementUnread {
		updates["unread_count"] = gorm.Expr("CASE WHEN read_through_mid < ? THEN unread_count + 1 ELSE unread_count END", mid)
	}
	return tx.Model(&model.InternalMessagingConversation{}).
		Where("user_id = ? AND peer_user_id = ?", userID, peerUserID).
		Updates(updates).Error
}

func (r *Repo) ListConversations(ctx context.Context, userID uint, offset, limit int) ([]domainmessaging.ConversationState, int64, int64, error) {
	var total int64
	if err := r.db.WithContext(ctx).Model(&model.InternalMessagingConversation{}).Where("user_id = ?", userID).Count(&total).Error; err != nil {
		return nil, 0, 0, err
	}
	totalUnread, err := r.TotalUnread(ctx, userID)
	if err != nil {
		return nil, 0, 0, err
	}
	var rows []model.InternalMessagingConversation
	if err := r.db.WithContext(ctx).Where("user_id = ?", userID).
		Order("pinned DESC").Order("last_message_at DESC").Order("last_message_mid DESC").
		Offset(offset).Limit(limit).Find(&rows).Error; err != nil {
		return nil, 0, 0, err
	}
	items := make([]domainmessaging.ConversationState, 0, len(rows))
	for _, row := range rows {
		items = append(items, toConversationState(row))
	}
	return items, total, totalUnread, nil
}

func (r *Repo) TotalUnread(ctx context.Context, userID uint) (int64, error) {
	var total int64
	err := r.db.WithContext(ctx).Model(&model.InternalMessagingConversation{}).
		Where("user_id = ?", userID).
		Select("COALESCE(SUM(unread_count), 0)").Scan(&total).Error
	return total, err
}

func (r *Repo) UserFileBytes(ctx context.Context, userID uint) (int64, error) {
	var total int64
	err := r.db.WithContext(ctx).Model(&model.InternalMessagingMessage{}).
		Where("sender_user_id = ? AND content_type = ? AND message_deleted = ?", userID, "vocechat/file", false).
		Select("COALESCE(SUM(file_size), 0)").Scan(&total).Error
	return total, err
}

func (r *Repo) MessageStats(ctx context.Context) (int64, int64, error) {
	var count int64
	// Deleted messages remain as tombstones in the local index so history,
	// unread reconciliation, and retention retries keep a stable MID. Report
	// every indexed row here; storage usage below intentionally counts only
	// active file payloads.
	if err := r.db.WithContext(ctx).Model(&model.InternalMessagingMessage{}).Count(&count).Error; err != nil {
		return 0, 0, err
	}
	var bytes int64
	if err := r.db.WithContext(ctx).Model(&model.InternalMessagingMessage{}).Where("message_deleted = ?", false).
		Select("COALESCE(SUM(file_size), 0)").Scan(&bytes).Error; err != nil {
		return 0, 0, err
	}
	return count, bytes, nil
}

func (r *Repo) ListMessagesBefore(ctx context.Context, before time.Time, limit int) ([]domainmessaging.MessageIndex, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	var rows []model.InternalMessagingMessage
	if err := r.db.WithContext(ctx).
		Where("sent_at < ? AND message_deleted = ?", before, false).
		Order("sent_at ASC").Limit(limit).Find(&rows).Error; err != nil {
		return nil, err
	}
	items := make([]domainmessaging.MessageIndex, 0, len(rows))
	for _, row := range rows {
		items = append(items, toMessageIndex(row))
	}
	return items, nil
}

func (r *Repo) MarkRead(ctx context.Context, userID, peerUserID uint, throughMID int64) error {
	state := model.InternalMessagingConversation{UserID: userID, PeerUserID: peerUserID}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ? AND peer_user_id = ?", userID, peerUserID).FirstOrCreate(&state).Error; err != nil {
			return err
		}
		// A client may only acknowledge messages that currently belong to this
		// conversation. Clamping prevents an arbitrary future MID from suppressing
		// unread counts for messages that have not arrived yet.
		if throughMID <= 0 || throughMID > state.LastMessageMID {
			throughMID = state.LastMessageMID
		}
		if throughMID < state.ReadThroughMID {
			throughMID = state.ReadThroughMID
		}
		if err := tx.Model(&model.InternalMessagingConversation{}).
			Where("user_id = ? AND peer_user_id = ?", userID, peerUserID).
			Update("read_through_mid", throughMID).Error; err != nil {
			return err
		}
		var unread int64
		if err := tx.Model(&model.InternalMessagingMessage{}).
			Where("sender_user_id = ? AND recipient_user_id = ? AND mid > ? AND message_deleted = ?", peerUserID, userID, throughMID, false).
			Count(&unread).Error; err != nil {
			return err
		}
		return tx.Model(&model.InternalMessagingConversation{}).
			Where("user_id = ? AND peer_user_id = ?", userID, peerUserID).
			Update("unread_count", unread).Error
	})
}

func (r *Repo) SetConversationPreferences(ctx context.Context, userID, peerUserID uint, pinned, muted *bool) error {
	state := model.InternalMessagingConversation{UserID: userID, PeerUserID: peerUserID}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ? AND peer_user_id = ?", userID, peerUserID).FirstOrCreate(&state).Error; err != nil {
			return err
		}
		updates := map[string]any{}
		if pinned != nil {
			updates["pinned"] = *pinned
		}
		if muted != nil {
			updates["muted"] = *muted
		}
		if len(updates) == 0 {
			return nil
		}
		return tx.Model(&model.InternalMessagingConversation{}).
			Where("user_id = ? AND peer_user_id = ?", userID, peerUserID).
			Updates(updates).Error
	})
}

func (r *Repo) SearchMessages(ctx context.Context, userID, peerUserID uint, query string, beforeMID int64, limit int) ([]domainmessaging.MessageIndex, error) {
	db := r.db.WithContext(ctx).Model(&model.InternalMessagingMessage{}).
		Where("(sender_user_id = ? OR recipient_user_id = ?) AND message_deleted = ?", userID, userID, false)
	if peerUserID != 0 {
		db = db.Where("((sender_user_id = ? AND recipient_user_id = ?) OR (sender_user_id = ? AND recipient_user_id = ?))", userID, peerUserID, peerUserID, userID)
	}
	if beforeMID > 0 {
		db = db.Where("mid < ?", beforeMID)
	}
	escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(strings.ToLower(strings.TrimSpace(query)))
	db = db.Where("LOWER(content) LIKE ? ESCAPE '\\'", "%"+escaped+"%")
	var rows []model.InternalMessagingMessage
	if err := db.Order("mid DESC").Limit(limit).Find(&rows).Error; err != nil {
		return nil, err
	}
	items := make([]domainmessaging.MessageIndex, 0, len(rows))
	for _, row := range rows {
		items = append(items, toMessageIndex(row))
	}
	return items, nil
}

func (r *Repo) FindMessage(ctx context.Context, userID uint, mid int64) (*domainmessaging.MessageIndex, error) {
	var item model.InternalMessagingMessage
	if err := r.db.WithContext(ctx).
		Where("mid = ? AND (sender_user_id = ? OR recipient_user_id = ?)", mid, userID, userID).
		First(&item).Error; err != nil {
		return nil, err
	}
	result := toMessageIndex(item)
	return &result, nil
}

func (r *Repo) FindMessages(ctx context.Context, userID uint, mids []int64) ([]domainmessaging.MessageIndex, error) {
	if len(mids) == 0 {
		return []domainmessaging.MessageIndex{}, nil
	}
	var rows []model.InternalMessagingMessage
	if err := r.db.WithContext(ctx).
		Where("mid IN ? AND (sender_user_id = ? OR recipient_user_id = ?)", mids, userID, userID).
		Find(&rows).Error; err != nil {
		return nil, err
	}
	items := make([]domainmessaging.MessageIndex, 0, len(rows))
	for _, row := range rows {
		items = append(items, toMessageIndex(row))
	}
	return items, nil
}

func (r *Repo) EditMessage(ctx context.Context, senderUserID uint, mid int64, contentType, content, metadataJSON string) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var item model.InternalMessagingMessage
		if err := tx.Where("mid = ? AND sender_user_id = ? AND message_deleted = ?", mid, senderUserID, false).First(&item).Error; err != nil {
			return err
		}
		if err := tx.Model(&item).Updates(map[string]any{
			"content_type": contentType, "content": content, "metadata_json": metadataJSON,
			"edited_at": gorm.Expr("CURRENT_TIMESTAMP"),
		}).Error; err != nil {
			return err
		}
		preview := messagePreview(content, contentType)
		return tx.Model(&model.InternalMessagingConversation{}).
			Where("last_message_mid = ?", mid).
			Update("last_message_preview", preview).Error
	})
}

func (r *Repo) DeleteMessage(ctx context.Context, actorUserID uint, mid int64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var item model.InternalMessagingMessage
		if err := tx.Where("mid = ? AND sender_user_id = ?", mid, actorUserID).First(&item).Error; err != nil {
			return err
		}
		if item.MessageDeleted {
			return nil
		}
		if err := tx.Model(&item).Updates(map[string]any{
			"message_deleted": true, "content": "", "metadata_json": "{}",
		}).Error; err != nil {
			return err
		}
		if err := tx.Model(&model.InternalMessagingConversation{}).
			Where("user_id = ? AND peer_user_id = ? AND read_through_mid < ? AND unread_count > 0", item.RecipientUserID, item.SenderUserID, mid).
			Update("unread_count", gorm.Expr("unread_count - 1")).Error; err != nil {
			return err
		}
		return tx.Model(&model.InternalMessagingConversation{}).
			Where("last_message_mid = ?", mid).
			Update("last_message_preview", "[消息已撤回]").Error
	})
}

func messagePreview(content, contentType string) string {
	if contentType != "" && contentType != "text/plain" && contentType != "text/markdown" {
		return "[文件]"
	}
	content = strings.Join(strings.Fields(content), " ")
	runes := []rune(content)
	if len(runes) > 160 {
		return string(runes[:160]) + "…"
	}
	return content
}

func toConversationState(item model.InternalMessagingConversation) domainmessaging.ConversationState {
	return domainmessaging.ConversationState{
		UserID: item.UserID, PeerUserID: item.PeerUserID, LastMessageMID: item.LastMessageMID,
		LastMessagePreview: item.LastMessagePreview, LastMessageAt: item.LastMessageAt,
		UnreadCount: item.UnreadCount, ReadThroughMID: item.ReadThroughMID,
		Pinned: item.Pinned, Muted: item.Muted,
	}
}

func toMessageIndex(item model.InternalMessagingMessage) domainmessaging.MessageIndex {
	return domainmessaging.MessageIndex{
		MID: item.MID, SenderUserID: item.SenderUserID, RecipientUserID: item.RecipientUserID,
		ContentType: item.ContentType, Content: item.Content, MetadataJSON: item.MetadataJSON,
		FileSize:   item.FileSize,
		ReplyToMID: item.ReplyToMID, SentAt: item.SentAt, EditedAt: item.EditedAt, Deleted: item.MessageDeleted,
	}
}
