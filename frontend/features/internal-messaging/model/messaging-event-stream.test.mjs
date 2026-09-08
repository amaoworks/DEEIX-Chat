import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createJSONEventStreamParser,
  messagingRetryDelay,
  startMessagingEventStream,
} from "./messaging-event-stream.ts";

test("event parser handles fragmented, multiple, CRLF, and residual frames", () => {
  const events = [];
  const parser = createJSONEventStreamParser((event) => events.push(event));

  parser.push('data: {"mid":1');
  assert.deepEqual(events, []);
  parser.push(',"type":"chat"}\n\ndata: {"mid":2}\r\n\r\n');
  parser.push(': heartbeat\n\ndata: not-json\n\n');
  parser.push('data: {"mid":3}');
  parser.finish();

  assert.deepEqual(events, [
    { mid: 1, type: "chat" },
    { mid: 2 },
    { mid: 3 },
  ]);
});

test("event stream reconnects from the greatest received MID and stops cleanly", async () => {
  const encoder = new TextEncoder();
  const afterMIDs = [];
  const received = [];
  let stop = () => {};
  let resolveComplete;
  const complete = new Promise((resolve) => {
    resolveComplete = resolve;
  });

  stop = startMessagingEventStream({
    retryDelayMS: 5,
    openStream: async (afterMID) => {
      afterMIDs.push(afterMID);
      const mid = afterMID ? 8 : 7;
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: {"mid":${mid}}\n\n`));
            controller.close();
          },
        }),
      };
    },
    onEvent: (event) => {
      received.push(event.mid);
      if (event.mid === 8) {
        stop();
        resolveComplete();
      }
    },
  });

  await complete;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(afterMIDs, [undefined, 7]);
  assert.deepEqual(received, [7, 8]);
});


test("retry delays grow exponentially with bounded jitter", () => {
  assert.equal(messagingRetryDelay(0, 1500, 30000, 0), 750);
  assert.equal(messagingRetryDelay(0, 1500, 30000, 1), 1500);
  assert.equal(messagingRetryDelay(3, 1500, 30000, 1), 12000);
  assert.equal(messagingRetryDelay(1000, 1500, 30000, 1), 30000);
});

test("a stalled stream is aborted and retries stop after unmount", async () => {
  let calls = 0;
  let aborted = 0;
  const stop = startMessagingEventStream({
    retryDelayMS: 5, idleTimeoutMS: 10,
    openStream: async (_after, signal) => {
      calls++;
      return { body: new ReadableStream({ start(controller) {
        signal.addEventListener("abort", () => { aborted++; controller.error(new Error("aborted")); });
      } }) };
    }, onEvent: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  stop();
  const stoppedCalls = calls;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(aborted >= 1);
  assert.ok(calls >= 2);
  assert.equal(calls, stoppedCalls);
});
