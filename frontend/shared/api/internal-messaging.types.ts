import type { PagePayload } from "@/shared/api/common.types";

export type InternalMessagingStatus = { enabled: boolean };
export type InternalMessagingUser = { publicID: string; username: string; displayName: string; avatarURL: string };
export type InternalMessagingMessage = { id: number; fromUserPublicID: string; content: string; createdAt: string };
export type InternalMessagingUserPage = PagePayload<InternalMessagingUser> & { hasMore: boolean };
