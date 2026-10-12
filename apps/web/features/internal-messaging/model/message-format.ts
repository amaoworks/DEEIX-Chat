import type { InternalMessagingUser } from "@/shared/api/internal-messaging-types";

export function displayName(user: InternalMessagingUser) {
  return user.displayName || user.username;
}

export function formatFileSize(bytes: number, locale: string, unknownSize: string) {
  if (!Number.isFinite(bytes) || bytes <= 0) return unknownSize;
  const format = (value: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${format(bytes / 1024)} KB`;
  return `${format(bytes / 1024 / 1024)} MB`;
}
