package internalmessaging

import (
	"context"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/persistence/models"
	"gorm.io/gorm"
)

// ApplyReaction is monotonic across SSE replay, API responses, repair workers,
// and application instances. Old edits never overwrite a newer edit or deletion.
func (r *Repo) ApplyReaction(ctx context.Context, senderID uint, mid, eventMID int64, contentType, content, metadata string, deleted bool) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var item model.InternalMessagingMessage
		if err := tx.Where("mid = ? AND sender_user_id = ?", mid, senderID).First(&item).Error; err != nil {
			return err
		}
		if item.MessageDeleted || item.LastEventMID >= eventMID {
			return nil
		}
		values := map[string]any{"last_event_mid": eventMID, "content_type": contentType,
			"content": content, "metadata_json": metadata, "edited_at": gorm.Expr("CURRENT_TIMESTAMP")}
		preview := messagePreview(content, contentType)
		if deleted {
			values["message_deleted"], values["content"], values["metadata_json"] = true, "", "{}"
			preview = "[消息已撤回]"
		}
		result := tx.Model(&item).Where("last_event_mid < ? AND message_deleted = ?", eventMID, false).Updates(values)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return nil
		}
		if deleted {
			if err := tx.Model(&model.InternalMessagingConversation{}).
				Where("user_id = ? AND peer_user_id = ? AND read_through_mid < ? AND unread_count > 0", item.RecipientUserID, item.SenderUserID, mid).
				Update("unread_count", gorm.Expr("unread_count - 1")).Error; err != nil {
				return err
			}
		}
		return tx.Model(&model.InternalMessagingConversation{}).Where("last_message_mid = ?", mid).Update("last_message_preview", preview).Error
	})
}
