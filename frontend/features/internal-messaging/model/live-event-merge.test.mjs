import assert from "node:assert/strict";
import { test } from "node:test";

import { applySelectedConversationLiveEvent } from "./live-event-merge.ts";
import { messageRowContainmentStyle } from "./message-row-visibility.ts";

function msg(id, extra = {}) {
  return { id, content: extra.content ?? `m${id}`, ...extra };
}

test("off-window reaction does not insert or advance the read cursor", () => {
  const result = applySelectedConversationLiveEvent({
    loaded: [msg(10), msg(11), msg(12)],
    incoming: msg(3, { content: "edited", deleted: true }),
    reaction: true,
  });
  assert.deepEqual(
    result.messages.map((item) => item.id),
    [10, 11, 12],
  );
  assert.equal(result.changed, false);
  assert.equal(result.advanceReadCursor, false);
  assert.equal(result.mergedAsTail, false);
});

test("in-window reaction updates that row without advancing the read cursor", () => {
  const result = applySelectedConversationLiveEvent({
    loaded: [msg(10), msg(11, { content: "old" }), msg(12)],
    incoming: msg(11, { content: "edited" }),
    reaction: true,
  });
  assert.deepEqual(
    result.messages.map((item) => item.id),
    [10, 11, 12],
  );
  assert.equal(result.messages.find((item) => item.id === 11)?.content, "edited");
  assert.equal(result.changed, true);
  assert.equal(result.advanceReadCursor, false);
  assert.equal(result.mergedAsTail, false);
});

test("newer non-reaction merges as a tail message", () => {
  const result = applySelectedConversationLiveEvent({
    loaded: [msg(10), msg(11), msg(12)],
    incoming: msg(13, { content: "new" }),
    reaction: false,
  });
  assert.deepEqual(
    result.messages.map((item) => item.id),
    [10, 11, 12, 13],
  );
  assert.equal(result.messages.at(-1)?.content, "new");
  assert.equal(result.changed, true);
  assert.equal(result.advanceReadCursor, true);
  assert.equal(result.mergedAsTail, true);
});

test("older non-reaction is not inserted", () => {
  const result = applySelectedConversationLiveEvent({
    loaded: [msg(10), msg(11), msg(12)],
    incoming: msg(3, { content: "stale" }),
    reaction: false,
  });
  assert.deepEqual(
    result.messages.map((item) => item.id),
    [10, 11, 12],
  );
  assert.equal(result.messages.some((item) => item.id === 3), false);
  assert.equal(result.changed, false);
  assert.equal(result.advanceReadCursor, false);
  assert.equal(result.mergedAsTail, false);
});

test("message rows disable content-visibility during older-history prepend/preserve", () => {
  assert.equal(
    messageRowContainmentStyle({
      loadingOlderMessages: true,
      preservingOlderScroll: false,
    }),
    undefined,
  );
  assert.equal(
    messageRowContainmentStyle({
      loadingOlderMessages: false,
      preservingOlderScroll: true,
    }),
    undefined,
  );
  assert.equal(
    messageRowContainmentStyle({
      loadingOlderMessages: false,
      preservingOlderScroll: false,
    }),
    undefined,
  );
});
