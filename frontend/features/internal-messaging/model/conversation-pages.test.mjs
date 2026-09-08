import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConversationPages } from "./conversation-pages.ts";

test("more than 50 conversations remain accessible and refresh preserves loaded pages", async () => {
  const peers = Array.from({ length: 125 }, (_, id) => ({ user: { publicID: `${id}` }, unreadCount: 1 }));
  const fetched = [];
  const fetch = async (page) => {
    fetched.push(page);
    return { results: peers.slice((page - 1) * 50, page * 50), hasMore: page < 3, total: 125, totalUnread: 125 };
  };
  const first = await loadConversationPages(fetch, 1, new AbortController().signal);
  assert.equal(first.snapshot.results.length, 50);
  assert.equal(first.snapshot.hasMore, true);
  const all = await loadConversationPages(fetch, 3, new AbortController().signal);
  assert.equal(all.snapshot.results.length, 125);
  assert.equal(all.snapshot.hasMore, false);
  peers[124].unreadCount = 0;
  const refreshed = await loadConversationPages(fetch, all.loaded, new AbortController().signal);
  assert.equal(refreshed.snapshot.results.length, 125);
  assert.equal(refreshed.snapshot.results[124].unreadCount, 0);
});

test("cancelled or stale pagination cannot publish a partial snapshot", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(loadConversationPages(async () => {
    calls++;
    controller.abort();
    return { results: [], hasMore: true };
  }, 3, controller.signal), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("conversations moving between pages are deduplicated", async () => {
  const { snapshot } = await loadConversationPages(async (page) => ({
    results: [{ user: { publicID: "same-peer" }, unreadCount: page }],
    total: 1, totalUnread: page, hasMore: page === 1,
  }), 2, new AbortController().signal);
  assert.equal(snapshot.results.length, 1);
  assert.equal(snapshot.results[0].unreadCount, 2);
});
