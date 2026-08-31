import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createCachedConversation,
  MAX_CACHED_CONVERSATIONS,
  MAX_CACHED_MESSAGES,
  MESSAGE_CACHE_TTL,
  readConversationCache,
  writeConversationCache,
} from "./conversation-cache.ts";

function messages(count, start = 1) {
  return Array.from({ length: count }, (_, index) => ({
    id: start + index,
    fromUserPublicID: "sender",
    contentType: "text/plain",
    content: `message-${start + index}`,
    replyToID: 0,
    createdAt: "2026-01-01T00:00:00Z",
    editedAt: "",
    deleted: false,
  }));
}

test("cached conversations retain a reloadable recent message window", () => {
  const entry = createCachedConversation(messages(MAX_CACHED_MESSAGES + 25), false, 0, 100);
  assert.equal(entry.messages.length, MAX_CACHED_MESSAGES);
  assert.equal(entry.messages[0].id, 26);
  assert.equal(entry.nextBefore, 26);
  assert.equal(entry.hasMore, true);
});

test("cache removes expired entries and keeps only recent conversations", () => {
  const cache = new Map();
  for (let index = 0; index < MAX_CACHED_CONVERSATIONS + 2; index += 1) {
    writeConversationCache(
      cache,
      `user-${index}`,
      createCachedConversation(messages(1), false, 0, index + 1),
    );
  }
  assert.equal(cache.size, MAX_CACHED_CONVERSATIONS);
  assert.equal(cache.has("user-0"), false);
  assert.equal(cache.has("user-1"), false);

  assert.equal(
    readConversationCache(cache, "user-2", MESSAGE_CACHE_TTL + 4),
    undefined,
  );
});

test("cache reads refresh least-recently-used ordering", () => {
  const cache = new Map();
  for (let index = 0; index < MAX_CACHED_CONVERSATIONS; index += 1) {
    writeConversationCache(
      cache,
      `user-${index}`,
      createCachedConversation(messages(1), false, 0, 100),
    );
  }
  assert.ok(readConversationCache(cache, "user-0", 101));
  writeConversationCache(
    cache,
    "new-user",
    createCachedConversation(messages(1), false, 0, 102),
  );
  assert.equal(cache.has("user-0"), true);
  assert.equal(cache.has("user-1"), false);
});
