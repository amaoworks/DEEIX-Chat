import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageComposer, shouldSendOnEnter } from "./message-composer.ts";
import { canReadConversation } from "./message-read-state.ts";

test("drafts and reply targets remain isolated when switching recipients", () => {
  const store = new MessageComposer();
  store.patch("alice", { content: "Only for Alice", replyTo: { id: 7 } });
  store.patch("bob", { content: "Only for Bob" });
  const outgoing = store.begin("bob");
  assert.equal(outgoing.peerID, "bob");
  assert.equal(outgoing.content, "Only for Bob");
  assert.equal(outgoing.replyToID, undefined);
  assert.equal(store.getSnapshot().drafts.alice.content, "Only for Alice");
  assert.equal(store.getSnapshot().drafts.alice.replyTo.id, 7);
  assert.equal(store.getSnapshot().drafts.bob.content, "");
});

test("a failed send cannot overwrite new typing or migrate to another conversation", () => {
  const store = new MessageComposer();
  store.patch("alice", { content: "First message" });
  const sent = store.begin("alice");
  store.patch("alice", { content: "New typing" });
  store.patch("bob", { content: "Bob's draft" });
  store.fail(sent.id);
  assert.equal(store.getSnapshot().drafts.alice.content, "New typing");
  assert.equal(store.getSnapshot().drafts.bob.content, "Bob's draft");
  assert.equal(store.getSnapshot().outgoing[0].status, "failed");
  const retry = store.retry(sent.id);
  assert.equal(retry.peerID, "alice");
  assert.equal(retry.content, "First message");
  assert.equal(store.retry(sent.id), undefined, "double retry must not start a second request");
  store.remove(sent.id);
  assert.equal(store.getSnapshot().outgoing.length, 0);
  assert.equal(store.getSnapshot().drafts.alice.content, "New typing");
});

test("pending edit and file retries retain their original targets", () => {
  const store = new MessageComposer();
  store.patch("alice", { content: "Edited", editing: { id: 42 } });
  const edit = store.begin("alice");
  store.fail(edit.id);
  assert.equal(store.retry(edit.id).editID, 42);
  store.patch("alice", { content: "Keep this draft" });
  const file = new File(["image"], "sample.png", { type: "image/png" });
  const upload = store.begin("alice", file);
  store.fail(upload.id);
  assert.equal(store.retry(upload.id).file, file);
  assert.equal(store.getSnapshot().drafts.alice.content, "Keep this draft");
});

test("IME confirmation, legacy composition, and Shift+Enter do not send", () => {
  const enter = { key: "Enter", shiftKey: false, isComposing: false };
  assert.equal(shouldSendOnEnter(enter), true);
  assert.equal(shouldSendOnEnter({ ...enter, isComposing: true }), false);
  assert.equal(shouldSendOnEnter({ ...enter, keyCode: 229 }), false);
  assert.equal(shouldSendOnEnter({ ...enter, shiftKey: true }), false);
  const store = new MessageComposer();
  store.patch("alice", { content: "😀".repeat(4001) });
  assert.equal(store.begin("alice"), undefined);
  store.patch("alice", { content: "😀".repeat(4000) });
  assert.ok(store.begin("alice"));
});

test("read receipts require a visible, focused conversation at its newest messages", () => {
  const reading = { open: true, enabled: true, visible: true, focused: true, nearBottom: true, selectedPeerID: "alice", peerID: "alice" };
  assert.equal(canReadConversation(reading), true);
  for (const flag of ["open", "enabled", "visible", "focused", "nearBottom"]) {
    assert.equal(canReadConversation({ ...reading, [flag]: false }), false, flag);
  }
  assert.equal(canReadConversation({ ...reading, selectedPeerID: "bob" }), false);
});
