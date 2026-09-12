export type MessageTimestampKind = "today" | "yesterday" | "date";

export type MessageTimestampParts = {
  kind: MessageTimestampKind;
  time: string;
  date: string;
};

export type NotificationPermissionState = NotificationPermission | "unsupported";

export type NotificationTooltipKey =
  | "notificationsDisabled"
  | "notificationsUnsupported"
  | "notificationsDenied"
  | "notificationsOn"
  | "notificationsOff";

export type NotificationButtonState = {
  disabled: boolean;
  active: boolean;
  tooltipKey: NotificationTooltipKey;
};

function startOfLocalDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

export function formatTime(value: string, locale: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function messageTimestampParts(
  value: string,
  locale: string,
  now = new Date(),
): MessageTimestampParts | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const time = formatTime(value, locale);
  const dateLabel = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  const dayDiff = Math.round(
    (startOfLocalDay(date) - startOfLocalDay(now)) / 86_400_000,
  );

  if (dayDiff === 0) return { kind: "today", time, date: dateLabel };
  if (dayDiff === -1) return { kind: "yesterday", time, date: dateLabel };
  return { kind: "date", time, date: dateLabel };
}

export function formatMessageTimestamp(
  value: string,
  locale: string,
  labels: { yesterday: string },
  now = new Date(),
) {
  const parts = messageTimestampParts(value, locale, now);
  if (!parts) return "";
  if (parts.kind === "today") return parts.time;
  if (parts.kind === "yesterday") return `${labels.yesterday} ${parts.time}`;
  return `${parts.date} ${parts.time}`;
}

export function formatMessageHoverLabel(
  createdAt: string,
  locale: string,
  labels: { yesterday: string; edited: string },
  edited: boolean,
  now = new Date(),
) {
  const timestamp = formatMessageTimestamp(createdAt, locale, labels, now);
  if (!timestamp) return "";
  if (edited) return `${timestamp} · ${labels.edited}`;
  return timestamp;
}

export function notificationButtonState(input: {
  adminAllowed: boolean;
  permission: NotificationPermissionState;
  enabled: boolean;
}): NotificationButtonState {
  if (!input.adminAllowed) {
    return { disabled: true, active: false, tooltipKey: "notificationsDisabled" };
  }
  if (input.permission === "unsupported") {
    return { disabled: true, active: false, tooltipKey: "notificationsUnsupported" };
  }
  if (input.permission === "denied") {
    return { disabled: true, active: false, tooltipKey: "notificationsDenied" };
  }
  const active = input.enabled && input.permission === "granted";
  return {
    disabled: false,
    active,
    tooltipKey: active ? "notificationsOn" : "notificationsOff",
  };
}
