import type { PagePayload } from "@/shared/api/common.types";

export type InternalMessagingStatus = {
  enabled: boolean;
  unreadCount: number;
  maxFileBytes: number;
  browserNotifications: boolean;
};
export type InternalMessagingUser = { publicID: string; username: string; displayName: string; avatarURL: string };
export type InternalMessagingMessage = {
  id: number;
  fromUserPublicID: string;
  contentType: string;
  content: string;
  replyToID: number;
  createdAt: string;
  editedAt: string;
  deleted: boolean;
  file?: InternalMessagingFile;
};
export type InternalMessagingFile = {
  name: string;
  contentType: string;
  size: number;
  image: boolean;
  width: number;
  height: number;
};
export type InternalMessagingMessagePage = {
  results: InternalMessagingMessage[];
  hasMore: boolean;
  nextBefore: number;
};
export type InternalMessagingUserPage = PagePayload<InternalMessagingUser> & { hasMore: boolean };
export type InternalMessagingConversation = {
  user: InternalMessagingUser;
  lastMessageID: number;
  lastMessagePreview: string;
  lastMessageAt: string;
  unreadCount: number;
  pinned: boolean;
  muted: boolean;
};
export type InternalMessagingConversationPage = PagePayload<InternalMessagingConversation> & {
  totalUnread: number;
  hasMore: boolean;
};
