import type { InternalMessagingMessage } from "@/shared/api/internal-messaging.types";

export type CachedConversation = {
  messages: InternalMessagingMessage[];
  hasMore: boolean;
  nextBefore: number;
  storedAt: number;
};

export const MESSAGE_CACHE_TTL = 30_000;
export const MAX_CACHED_CONVERSATIONS = 8;
export const MAX_CACHED_MESSAGES = 300;
export const MAX_CONCURRENT_PREFETCHES = 3;

export function createCachedConversation(
  messages: InternalMessagingMessage[],
  hasMore: boolean,
  nextBefore: number,
  storedAt = Date.now(),
): CachedConversation {
  const retained = messages.slice(-MAX_CACHED_MESSAGES);
  const truncated = retained.length < messages.length;
  return {
    messages: retained,
    hasMore: hasMore || truncated,
    nextBefore: truncated ? retained[0]?.id || nextBefore : nextBefore,
    storedAt,
  };
}

export function pruneConversationCache(
  cache: Map<string, CachedConversation>,
  now = Date.now(),
) {
  for (const [publicID, entry] of cache) {
    if (now - entry.storedAt >= MESSAGE_CACHE_TTL) cache.delete(publicID);
  }
  while (cache.size > MAX_CACHED_CONVERSATIONS) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== "string") break;
    cache.delete(oldest);
  }
}

export function writeConversationCache(
  cache: Map<string, CachedConversation>,
  publicID: string,
  entry: CachedConversation,
) {
  pruneConversationCache(cache, entry.storedAt);
  cache.delete(publicID);
  cache.set(publicID, entry);
  pruneConversationCache(cache, entry.storedAt);
}

export function readConversationCache(
  cache: Map<string, CachedConversation>,
  publicID: string,
  now = Date.now(),
) {
  pruneConversationCache(cache, now);
  const entry = cache.get(publicID);
  if (!entry) return undefined;
  cache.delete(publicID);
  cache.set(publicID, entry);
  return entry;
}
