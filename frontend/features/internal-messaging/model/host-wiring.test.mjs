import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hostSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../components/internal-messaging-host.tsx"),
  "utf8",
);
const launcherSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../components/internal-messaging-launcher.tsx"),
  "utf8",
);

test("host uses the shipped markdown, live-event, and containment helpers", () => {
  assert.equal(hostSource.includes("function safeInternalMessageMarkdown"), false);
  assert.equal(hostSource.includes("function mergeMessages"), false);
  assert.equal(hostSource.includes('contentVisibility: "auto"'), false);
  assert.equal(
    hostSource.includes("@/features/internal-messaging/model/message-markdown"),
    true,
  );
  assert.equal(
    hostSource.includes("@/features/internal-messaging/model/live-event-merge"),
    true,
  );
  assert.equal(
    hostSource.includes("@/features/internal-messaging/model/message-row-visibility"),
    true,
  );
  assert.equal(hostSource.includes("safeInternalMessageMarkdown("), true);
  assert.equal(hostSource.includes("applySelectedConversationLiveEvent("), true);
  assert.equal(hostSource.includes("messageRowContainmentStyle("), true);
  assert.equal(hostSource.includes('from "@/shared/components/markdown/streamdown-render"'), false);
  assert.equal(hostSource.includes("useVirtualizer("), true);
  assert.equal(hostSource.includes("writeConversationCache("), true);
});

test("lightweight launcher defers the complete messaging window", () => {
  assert.equal(launcherSource.includes('import("./internal-messaging-host")'), true);
  assert.equal(launcherSource.includes("React.lazy("), true);
  assert.equal(launcherSource.includes("useLauncherEvents("), true);
  assert.equal(launcherSource.includes("LazyInternalMessagingWindow"), true);
});
