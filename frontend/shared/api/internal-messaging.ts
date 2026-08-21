import { authedFetch, authedRequest } from "@/shared/api/authed-client";
import { pathParam } from "@/shared/api/http-client";
import type { InternalMessagingMessage, InternalMessagingStatus, InternalMessagingUserPage } from "@/shared/api/internal-messaging.types";

const ROOT = "/api/v1/internal-messaging";

export function getInternalMessagingStatus(accessToken: string) {
  return authedRequest<InternalMessagingStatus>(`${ROOT}/status`, { accessToken }, false);
}

export function listInternalMessagingUsers(accessToken: string, query = "", page = 1) {
  const params = new URLSearchParams({ page: String(page), page_size: "50" });
  if (query.trim()) params.set("query", query.trim());
  return authedRequest<InternalMessagingUserPage>(`${ROOT}/users?${params}`, { accessToken });
}

export function listInternalMessagingMessages(accessToken: string, publicID: string, before?: number) {
  const suffix = before ? `?before=${before}` : "";
  return authedRequest<InternalMessagingMessage[]>(`${ROOT}/users/${pathParam(publicID)}/messages${suffix}`, { accessToken });
}

export function sendInternalMessagingMessage(accessToken: string, publicID: string, content: string) {
  return authedRequest<InternalMessagingMessage>(`${ROOT}/users/${pathParam(publicID)}/messages`, {
    method: "POST",
    accessToken,
    body: { content },
  });
}

export function openInternalMessagingEvents(accessToken: string, after?: number, signal?: AbortSignal) {
  const suffix = after ? `?after=${after}` : "";
  return authedFetch(`${ROOT}/events${suffix}`, { method: "GET", accessToken, signal }, false);
}
