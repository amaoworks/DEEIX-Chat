import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatMessageHoverLabel,
  formatMessageTimestamp,
  formatTime,
  notificationButtonState,
} from "./message-time.ts";

const now = new Date(2026, 8, 12, 15, 0, 0);
const labels = { yesterday: "昨天", edited: "已编辑" };

test("conversation list time is hour and minute only", () => {
  const value = new Date(2026, 8, 12, 14, 32, 0).toISOString();
  const formatted = formatTime(value, "en-US");
  assert.equal(formatted.length > 0, true);
  assert.equal(formatted.includes("2026"), false);
});

test("hover timestamp is time-only today, labeled yesterday, and dated otherwise", () => {
  const today = new Date(2026, 8, 12, 14, 32, 0).toISOString();
  const yesterday = new Date(2026, 8, 11, 9, 5, 0).toISOString();
  const older = new Date(2026, 7, 1, 8, 0, 0).toISOString();

  const todayLabel = formatMessageTimestamp(today, "zh-CN", labels, now);
  assert.equal(todayLabel.includes("昨天"), false);
  assert.equal(todayLabel.includes("2026-"), false);
  assert.equal(todayLabel.length > 0, true);

  const yesterdayLabel = formatMessageTimestamp(yesterday, "zh-CN", labels, now);
  assert.equal(yesterdayLabel.startsWith("昨天 "), true);
  assert.equal(yesterdayLabel.includes("2026-"), false);

  const olderLabel = formatMessageTimestamp(older, "zh-CN", labels, now);
  assert.equal(olderLabel.startsWith("2026-08-01 "), true);
});

test("edited hover labels append after the timestamp", () => {
  const today = new Date(2026, 8, 12, 14, 32, 0).toISOString();
  const label = formatMessageHoverLabel(today, "zh-CN", labels, true, now);
  assert.equal(label.endsWith(" · 已编辑"), true);
  assert.equal(label.includes("2026-"), false);
});

test("invalid timestamps stay empty", () => {
  assert.equal(formatTime("not-a-date", "zh-CN"), "");
  assert.equal(formatMessageTimestamp("not-a-date", "zh-CN", labels, now), "");
  assert.equal(formatMessageHoverLabel("not-a-date", "zh-CN", labels, true, now), "");
});

test("notification button explains why it cannot toggle", () => {
  assert.deepEqual(
    notificationButtonState({
      adminAllowed: false,
      permission: "granted",
      enabled: true,
    }),
    { disabled: true, active: false, tooltipKey: "notificationsDisabled" },
  );
  assert.deepEqual(
    notificationButtonState({
      adminAllowed: true,
      permission: "denied",
      enabled: true,
    }),
    { disabled: true, active: false, tooltipKey: "notificationsDenied" },
  );
  assert.deepEqual(
    notificationButtonState({
      adminAllowed: true,
      permission: "unsupported",
      enabled: false,
    }),
    { disabled: true, active: false, tooltipKey: "notificationsUnsupported" },
  );
  assert.deepEqual(
    notificationButtonState({
      adminAllowed: true,
      permission: "granted",
      enabled: true,
    }),
    { disabled: false, active: true, tooltipKey: "notificationsOn" },
  );
  assert.deepEqual(
    notificationButtonState({
      adminAllowed: true,
      permission: "default",
      enabled: true,
    }),
    { disabled: false, active: false, tooltipKey: "notificationsOff" },
  );
});
