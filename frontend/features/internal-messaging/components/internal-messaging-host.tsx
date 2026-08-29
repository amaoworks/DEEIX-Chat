"use client";

import * as React from "react";
import {
  Bell,
  BellOff,
  Check,
  ChevronDown,
  ChevronLeft,
  Clipboard,
  CornerUpLeft,
  Download,
  FileIcon,
  LoaderCircle,
  Maximize2,
  MessageCircle,
  Paperclip,
  Pencil,
  Pin,
  Search,
  Send,
  Smile,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { StreamdownRender } from "@/shared/components/markdown/streamdown-render";
import {
  deleteInternalMessagingMessage,
  downloadInternalMessagingFile,
  editInternalMessagingMessage,
  getInternalMessagingStatus,
  listInternalMessagingConversations,
  listInternalMessagingMessages,
  listInternalMessagingUsers,
  markInternalMessagingRead,
  openInternalMessagingEvents,
  replyInternalMessagingMessage,
  searchInternalMessagingMessages,
  sendInternalMessagingMessage,
  sendInternalMessagingFile,
  updateInternalMessagingPreferences,
} from "@/shared/api/internal-messaging";
import type {
  InternalMessagingConversation,
  InternalMessagingMessage,
  InternalMessagingUser,
} from "@/shared/api/internal-messaging.types";
import { useAuthSession } from "@/shared/auth/auth-session-context";

type Point = { x: number; y: number };
type WindowBounds = Point & { width: number; height: number };
type DragSnapshot = {
  pointerID: number;
  startX: number;
  startY: number;
  origin: Point;
  moved: boolean;
};
type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
type ResizeSnapshot = {
  pointerID: number;
  startX: number;
  startY: number;
  direction: ResizeDirection;
  bounds: WindowBounds;
};
type PendingMessageScroll =
  | { mode: "bottom"; behavior: ScrollBehavior }
  | { mode: "preserve"; scrollHeight: number; scrollTop: number };
type CachedConversation = {
  messages: InternalMessagingMessage[];
  hasMore: boolean;
  nextBefore: number;
  storedAt: number;
};
type MessagingEvent = {
  type?: string;
  mid?: number;
  fromUserPublicID?: string;
  conversationPublicID?: string;
  message?: InternalMessagingMessage;
  users?: Array<{ publicID: string; online: boolean }>;
  detail?: {
    type?: string;
    content?: string;
    content_type?: string;
    mid?: number;
    detail?: { type?: string; content?: string };
  };
};

class MessageRenderBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const VIEWPORT_MARGIN = 8;
const BUTTON_SIZE = 44;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 360;
const LAYOUT_STORAGE_PREFIX = "deeix.internal-messaging.layout.v1";
const NOTIFICATION_STORAGE_PREFIX = "deeix.internal-messaging.notifications.v1";
const MESSAGE_BOTTOM_THRESHOLD = 80;
const MESSAGE_CACHE_TTL = 30_000;
const COMMON_EMOJIS = [
  "😀", "😃", "😄", "😁", "😂", "😊", "😍", "🥰",
  "😘", "😎", "🤔", "😅", "😭", "😡", "🥳", "🤩",
  "👍", "👎", "👏", "🙏", "💪", "👌", "✌️", "🤝",
  "❤️", "💔", "🔥", "🎉", "✨", "💯", "✅", "🚀",
];

const RESIZE_HANDLES: Array<{ direction: ResizeDirection; className: string }> = [
  { direction: "n", className: "-top-1 left-3 right-3 h-2 cursor-n-resize" },
  { direction: "ne", className: "-right-1 -top-1 size-4 cursor-ne-resize" },
  { direction: "e", className: "-right-1 bottom-3 top-3 w-2 cursor-e-resize" },
  { direction: "se", className: "-bottom-1 -right-1 size-5 cursor-se-resize" },
  { direction: "s", className: "-bottom-1 left-3 right-3 h-2 cursor-s-resize" },
  { direction: "sw", className: "-bottom-1 -left-1 size-4 cursor-sw-resize" },
  { direction: "w", className: "-left-1 bottom-3 top-3 w-2 cursor-w-resize" },
  { direction: "nw", className: "-left-1 -top-1 size-4 cursor-nw-resize" },
];

function initials(value: string) {
  return value.trim().slice(0, 2).toUpperCase() || "?";
}

function displayName(user: InternalMessagingUser) {
  return user.displayName || user.username;
}

function safeInternalMessageMarkdown(content: string) {
  // Internal messages use authenticated file attachments for images. Render
  // Markdown image syntax as its alt text so a message cannot trigger a
  // background request to an arbitrary third-party tracking URL.
  return content
    .replace(/!\[([^\]]*)\]\((?:\\.|[^)])*\)/g, "$1")
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<img\b[^>]*>/gi, "");
}

function mergeMessages(
  ...groups: InternalMessagingMessage[][]
): InternalMessagingMessage[] {
  const byID = new Map<number, InternalMessagingMessage>();
  for (const group of groups) {
    for (const message of group) byID.set(message.id, message);
  }
  return [...byID.values()].sort((left, right) => left.id - right.id);
}

function formatTime(value: string, locale: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function initialWindowBounds(): WindowBounds {
  if (typeof window === "undefined") {
    return { x: 24, y: 24, width: 400, height: 600 };
  }
  const width = Math.min(400, Math.max(240, window.innerWidth - VIEWPORT_MARGIN * 2));
  const height = Math.min(640, Math.max(320, window.innerHeight - VIEWPORT_MARGIN * 2));
  return {
    x: Math.max(VIEWPORT_MARGIN, window.innerWidth - width - 20),
    y: Math.max(VIEWPORT_MARGIN, window.innerHeight - height - 20),
    width,
    height,
  };
}

function clampWindowBounds(bounds: WindowBounds): WindowBounds {
  const maximumWidth = Math.max(1, window.innerWidth - VIEWPORT_MARGIN * 2);
  const maximumHeight = Math.max(1, window.innerHeight - VIEWPORT_MARGIN * 2);
  const minimumWidth = Math.min(MIN_WINDOW_WIDTH, maximumWidth);
  const minimumHeight = Math.min(MIN_WINDOW_HEIGHT, maximumHeight);
  const width = clamp(bounds.width, minimumWidth, maximumWidth);
  const height = clamp(bounds.height, minimumHeight, maximumHeight);
  return {
    x: clamp(bounds.x, VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
    y: clamp(bounds.y, VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN),
    width,
    height,
  };
}

function clampButtonPoint(point: Point): Point {
  return {
    x: clamp(point.x, VIEWPORT_MARGIN, window.innerWidth - BUTTON_SIZE - VIEWPORT_MARGIN),
    y: clamp(point.y, VIEWPORT_MARGIN, window.innerHeight - BUTTON_SIZE - VIEWPORT_MARGIN),
  };
}

function isPoint(value: unknown): value is Point {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Point>;
  return Number.isFinite(candidate.x) && Number.isFinite(candidate.y);
}

function isWindowBounds(value: unknown): value is WindowBounds {
  if (!isPoint(value)) return false;
  const candidate = value as Partial<WindowBounds>;
  return Number.isFinite(candidate.width) && Number.isFinite(candidate.height);
}

function useMobileMessagingLayout() {
  const [mobile, setMobile] = React.useState(false);

  React.useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return mobile;
}

function useMessagingEvents(
  enabled: boolean,
  accessToken: string,
  onEvent: (event: MessagingEvent) => void,
  onConnectionChange: (connected: boolean) => void,
) {
  const latestMID = React.useRef(0);
  const callback = React.useRef(onEvent);
  const connectionCallback = React.useRef(onConnectionChange);
  callback.current = onEvent;
  connectionCallback.current = onConnectionChange;

  React.useEffect(() => {
    if (!enabled || !accessToken) return;
    let cancelled = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = async () => {
      controller = new AbortController();
      try {
        const response = await openInternalMessagingEvents(
          accessToken,
          latestMID.current || undefined,
          controller.signal,
        );
        const reader = response.body?.getReader();
        if (!reader) throw new Error("event stream is unavailable");
        connectionCallback.current(true);
        const decoder = new TextDecoder();
        let pending = "";
        while (!cancelled) {
          const next = await reader.read();
          if (next.done) break;
          pending += decoder.decode(next.value, { stream: true });
          const events = pending.split("\n\n");
          pending = events.pop() || "";
          for (const event of events) {
            const data = event
              .split("\n")
              .find((line) => line.startsWith("data:"))
              ?.slice(5)
              .trim();
            if (!data) continue;
            try {
              const payload = JSON.parse(data) as MessagingEvent;
              if (typeof payload.mid === "number") {
                latestMID.current = Math.max(latestMID.current, payload.mid);
              }
              if (
                payload.type === "chat" ||
                payload.type === "users_state" ||
                payload.type === "users_state_changed"
              ) {
                callback.current(payload);
              }
            } catch {
              // Heartbeats and non-JSON events still indicate a live connection.
            }
          }
        }
      } catch {
        // The next retry also covers temporary VoceChat unavailability.
      }
      connectionCallback.current(false);
      if (!cancelled) retryTimer = setTimeout(connect, 1500);
    };
    void connect();
    return () => {
      cancelled = true;
      controller?.abort();
      connectionCallback.current(false);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [accessToken, enabled]);
}

export function InternalMessagingHost() {
  const t = useTranslations("internalMessaging");
  const locale = useLocale();
  const mobileLayout = useMobileMessagingLayout();
  const { accessToken, user } = useAuthSession();
  const [enabled, setEnabled] = React.useState(false);
  const [maxFileBytes, setMaxFileBytes] = React.useState(20 * 1024 * 1024);
  const [browserNotificationsAllowed, setBrowserNotificationsAllowed] = React.useState(true);
  const [open, setOpen] = React.useState(false);
  const [users, setUsers] = React.useState<InternalMessagingUser[]>([]);
  const [conversations, setConversations] = React.useState<InternalMessagingConversation[]>([]);
  const [directoryView, setDirectoryView] = React.useState<"recent" | "users">("recent");
  const [query, setQuery] = React.useState("");
  const [directoryPage, setDirectoryPage] = React.useState(1);
  const [hasMoreUsers, setHasMoreUsers] = React.useState(false);
  const [selected, setSelected] = React.useState<InternalMessagingUser | null>(null);
  const [messages, setMessages] = React.useState<InternalMessagingMessage[]>([]);
  const [draft, setDraft] = React.useState("");
  const [loadingUsers, setLoadingUsers] = React.useState(false);
  const [loadingMessages, setLoadingMessages] = React.useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = React.useState(false);
  const [hasMoreMessages, setHasMoreMessages] = React.useState(false);
  const [nextBefore, setNextBefore] = React.useState(0);
  const [sending, setSending] = React.useState(false);
  const [replyTo, setReplyTo] = React.useState<InternalMessagingMessage | null>(null);
  const [editing, setEditing] = React.useState<InternalMessagingMessage | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [unreadByUser, setUnreadByUser] = React.useState<Record<string, number>>({});
  const [totalUnread, setTotalUnread] = React.useState(0);
  const [messageSearchOpen, setMessageSearchOpen] = React.useState(false);
  const [messageSearchQuery, setMessageSearchQuery] = React.useState("");
  const [messageSearchResults, setMessageSearchResults] = React.useState<InternalMessagingMessage[]>([]);
  const [searchingMessages, setSearchingMessages] = React.useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = React.useState(false);
  const [directoryError, setDirectoryError] = React.useState("");
  const [messageError, setMessageError] = React.useState("");
  const [actionError, setActionError] = React.useState("");
  const [newMessagesBelow, setNewMessagesBelow] = React.useState(false);
  const [draggingFile, setDraggingFile] = React.useState(false);
  const [previewMessage, setPreviewMessage] =
    React.useState<InternalMessagingMessage | null>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = React.useState(false);
  const [presenceReady, setPresenceReady] = React.useState(false);
  const [onlineByUser, setOnlineByUser] = React.useState<Record<string, boolean>>({});
  const [buttonPoint, setButtonPoint] = React.useState<Point | null>(null);
  const [windowBounds, setWindowBounds] = React.useState<WindowBounds>(initialWindowBounds);
  const selectedRef = React.useRef<InternalMessagingUser | null>(null);
  const buttonDragRef = React.useRef<DragSnapshot | null>(null);
  const windowDragRef = React.useRef<DragSnapshot | null>(null);
  const resizeRef = React.useRef<ResizeSnapshot | null>(null);
  const suppressButtonClickRef = React.useRef(false);
  const layoutHydratedRef = React.useRef(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
  const messageViewportRef = React.useRef<HTMLDivElement | null>(null);
  const messagesRef = React.useRef<InternalMessagingMessage[]>([]);
  const nearMessageBottomRef = React.useRef(true);
  const pendingMessageScrollRef = React.useRef<PendingMessageScroll | null>(null);
  const messageRequestRef = React.useRef<{
    sequence: number;
    controller: AbortController | null;
  }>({ sequence: 0, controller: null });
  const conversationRefreshTimerRef = React.useRef<number | null>(null);
  const messageRefreshTimerRef = React.useRef<number | null>(null);
  const readRetryTimersRef = React.useRef<Set<number>>(new Set());
  const messageCacheRef = React.useRef<Map<string, CachedConversation>>(new Map());
  const messagePrefetchRef = React.useRef<Map<string, Promise<void>>>(new Map());
  selectedRef.current = selected;
  messagesRef.current = messages;

  const scrollToMessageBottom = React.useCallback((behavior: ScrollBehavior = "smooth") => {
    const viewport = messageViewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    nearMessageBottomRef.current = true;
    setNewMessagesBelow(false);
  }, []);

  const maintainMessageBottom = React.useCallback(() => {
    if (nearMessageBottomRef.current) scrollToMessageBottom("auto");
  }, [scrollToMessageBottom]);

  const messageByID = React.useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );

  React.useEffect(() => {
    if (!selected) return;
    messageCacheRef.current.set(selected.publicID, {
      messages,
      hasMore: hasMoreMessages,
      nextBefore,
      storedAt: Date.now(),
    });
  }, [hasMoreMessages, messages, nextBefore, selected]);

  React.useLayoutEffect(() => {
    const viewport = messageViewportRef.current;
    const pending = pendingMessageScrollRef.current;
    if (!viewport || !pending) return;
    pendingMessageScrollRef.current = null;
    if (pending.mode === "preserve") {
      viewport.scrollTop =
        pending.scrollTop + (viewport.scrollHeight - pending.scrollHeight);
      return;
    }
    scrollToMessageBottom(pending.behavior);
  }, [messages, scrollToMessageBottom]);

  const handleMessageScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const viewport = event.currentTarget;
    const distance = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    const nearBottom = distance <= MESSAGE_BOTTOM_THRESHOLD;
    nearMessageBottomRef.current = nearBottom;
    if (nearBottom) setNewMessagesBelow(false);
  };

  React.useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void getInternalMessagingStatus(accessToken)
        .then((status) => {
          if (disposed) return;
          setEnabled(status.enabled);
          setTotalUnread(status.unreadCount || 0);
          setMaxFileBytes(status.maxFileBytes || 20 * 1024 * 1024);
          setBrowserNotificationsAllowed(status.browserNotifications);
        })
        .catch(() => {
          if (!disposed) setEnabled(false);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [accessToken]);

  React.useEffect(() => {
    if (enabled) return;
    setOpen(false);
    setSelected(null);
    setMessages([]);
    setReplyTo(null);
    setEditing(null);
    setPreviewMessage(null);
  }, [enabled]);

  React.useEffect(() => {
    setButtonPoint((current) =>
      current
        ? clampButtonPoint(current)
        : {
            x: window.innerWidth - BUTTON_SIZE - 20,
            y: window.innerHeight - BUTTON_SIZE - 20,
          },
    );
    setWindowBounds((current) => clampWindowBounds(current));

    const handleResize = () => {
      setButtonPoint((current) => (current ? clampButtonPoint(current) : current));
      setWindowBounds((current) => clampWindowBounds(current));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  React.useEffect(() => {
    if (!user?.publicID) return;
    layoutHydratedRef.current = false;
    try {
      const raw = window.localStorage.getItem(`${LAYOUT_STORAGE_PREFIX}:${user.publicID}`);
      if (raw) {
        const stored = JSON.parse(raw) as { button?: unknown; window?: unknown };
        if (isPoint(stored.button)) setButtonPoint(clampButtonPoint(stored.button));
        if (isWindowBounds(stored.window)) setWindowBounds(clampWindowBounds(stored.window));
      }
      setNotificationsEnabled(
        window.localStorage.getItem(`${NOTIFICATION_STORAGE_PREFIX}:${user.publicID}`) === "true",
      );
    } catch {
      // Invalid local UI state falls back to the safe viewport defaults.
    }
    layoutHydratedRef.current = true;
  }, [user?.publicID]);

  React.useEffect(() => {
    if (!user?.publicID || !layoutHydratedRef.current) return;
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(
        `${LAYOUT_STORAGE_PREFIX}:${user.publicID}`,
        JSON.stringify({ button: buttonPoint, window: windowBounds }),
      );
    }, 200);
    return () => window.clearTimeout(timer);
  }, [buttonPoint, user?.publicID, windowBounds]);

  React.useEffect(() => {
    if (!browserNotificationsAllowed) setNotificationsEnabled(false);
  }, [browserNotificationsAllowed]);

  const loadConversations = React.useCallback(async () => {
    if (!enabled) return undefined;
    try {
      const result = await listInternalMessagingConversations(accessToken);
      setConversations(result.results);
      setTotalUnread(result.totalUnread);
      setUnreadByUser(
        Object.fromEntries(
          result.results
            .filter((item) => item.unreadCount > 0)
            .map((item) => [item.user.publicID, item.unreadCount]),
        ),
      );
      return result;
    } catch {
      // Keep the last durable snapshot while the optional service reconnects.
      return undefined;
    }
  }, [accessToken, enabled]);

  const scheduleConversationRefresh = React.useCallback(() => {
    if (conversationRefreshTimerRef.current) return;
    conversationRefreshTimerRef.current = window.setTimeout(() => {
      conversationRefreshTimerRef.current = null;
      void loadConversations();
    }, 150);
  }, [loadConversations]);

  const syncReadState = React.useCallback(
    (recipientPublicID: string, throughMID: number, attempt = 0) => {
      void markInternalMessagingRead(accessToken, recipientPublicID, throughMID)
        .then(() => scheduleConversationRefresh())
        .catch(() => {
          const delays = [500, 1500];
          if (attempt >= delays.length) return;
          const timer = window.setTimeout(() => {
            readRetryTimersRef.current.delete(timer);
            syncReadState(recipientPublicID, throughMID, attempt + 1);
          }, delays[attempt]);
          readRetryTimersRef.current.add(timer);
        });
    },
    [accessToken, scheduleConversationRefresh],
  );

  const loadUsers = React.useCallback(
    async (page = 1, append = false) => {
      if (!enabled) return;
      setLoadingUsers(true);
      setDirectoryError("");
      try {
        const result = await listInternalMessagingUsers(accessToken, query, page);
        setUsers((items) => (append ? [...items, ...result.results] : result.results));
        setDirectoryPage(page);
        setHasMoreUsers(result.hasMore);
      } catch {
        setDirectoryError(t("errors.directory"));
      } finally {
        setLoadingUsers(false);
      }
    },
    [accessToken, enabled, query, t],
  );

  const loadMessages = React.useCallback(
    async (recipient: InternalMessagingUser, before = 0) => {
      messageRequestRef.current.controller?.abort();
      const controller = new AbortController();
      const sequence = messageRequestRef.current.sequence + 1;
      messageRequestRef.current = { sequence, controller };
      setLoadingMessages(!before);
      setLoadingOlderMessages(Boolean(before));
      if (before) setActionError("");
      else setMessageError("");
      try {
        const page = await listInternalMessagingMessages(
          accessToken,
          recipient.publicID,
          before || undefined,
          controller.signal,
        );
        if (
          sequence !== messageRequestRef.current.sequence ||
          selectedRef.current?.publicID !== recipient.publicID
        ) {
          return;
        }
        const next = mergeMessages(page.results);
        const previous = messagesRef.current;
        const viewport = messageViewportRef.current;
        if (before && viewport) {
          pendingMessageScrollRef.current = {
            mode: "preserve",
            scrollHeight: viewport.scrollHeight,
            scrollTop: viewport.scrollTop,
          };
        } else if (!before) {
          if (previous.length === 0 || nearMessageBottomRef.current) {
            pendingMessageScrollRef.current = { mode: "bottom", behavior: "auto" };
          } else {
            const previousMID = previous.reduce(
              (maximum, item) => Math.max(maximum, item.id),
              0,
            );
            const nextMID = next.reduce((maximum, item) => Math.max(maximum, item.id), 0);
            if (nextMID > previousMID) setNewMessagesBelow(true);
          }
        }
        const merged = before ? mergeMessages(next, previous) : next;
        setMessages(merged);
        setHasMoreMessages(page.hasMore);
        setNextBefore(page.nextBefore);
        messageCacheRef.current.set(recipient.publicID, {
          messages: merged,
          hasMore: page.hasMore,
          nextBefore: page.nextBefore,
          storedAt: Date.now(),
        });
        if (!before) {
          const throughMID = next.reduce((maximum, item) => Math.max(maximum, item.id), 0);
          // History is ready to render. Durable read-state reconciliation is
          // intentionally background work so cross-origin development latency
          // does not keep the message list behind a loading indicator.
          syncReadState(recipient.publicID, throughMID);
        }
      } catch {
        if (controller.signal.aborted || sequence !== messageRequestRef.current.sequence) return;
        if (before) setActionError(t("errors.olderHistory"));
        else setMessageError(t("errors.history"));
      } finally {
        if (sequence === messageRequestRef.current.sequence) {
          messageRequestRef.current.controller = null;
          setLoadingMessages(false);
          setLoadingOlderMessages(false);
        }
      }
    },
    [accessToken, syncReadState, t],
  );

  const prefetchMessages = React.useCallback(
    (recipient: InternalMessagingUser) => {
      const cached = messageCacheRef.current.get(recipient.publicID);
      if (cached && Date.now() - cached.storedAt < MESSAGE_CACHE_TTL) return;
      if (messagePrefetchRef.current.has(recipient.publicID)) return;
      const request = listInternalMessagingMessages(accessToken, recipient.publicID)
        .then((page) => {
          messageCacheRef.current.set(recipient.publicID, {
            messages: mergeMessages(page.results),
            hasMore: page.hasMore,
            nextBefore: page.nextBefore,
            storedAt: Date.now(),
          });
        })
        .catch(() => undefined)
        .finally(() => messagePrefetchRef.current.delete(recipient.publicID));
      messagePrefetchRef.current.set(recipient.publicID, request);
    },
    [accessToken],
  );

  React.useEffect(() => {
    if (enabled) void loadConversations();
  }, [enabled, loadConversations]);
  React.useEffect(() => {
    if (!enabled) return;
    const refresh = () => void loadConversations();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [enabled, loadConversations]);
  React.useEffect(() => {
    if (open && directoryView === "users") void loadUsers(1, false);
  }, [directoryView, loadUsers, open]);
  React.useEffect(() => {
    if (open && selected) void loadMessages(selected);
  }, [loadMessages, open, selected]);
  React.useEffect(
    () => () => {
      messageRequestRef.current.controller?.abort();
      if (conversationRefreshTimerRef.current) {
        window.clearTimeout(conversationRefreshTimerRef.current);
      }
      if (messageRefreshTimerRef.current) window.clearTimeout(messageRefreshTimerRef.current);
      for (const timer of readRetryTimersRef.current) window.clearTimeout(timer);
      readRetryTimersRef.current.clear();
    },
    [],
  );

  useMessagingEvents(enabled, accessToken, (event) => {
    if (event.type === "users_state" || event.type === "users_state_changed") {
      const states = event.users || [];
      setOnlineByUser((current) => {
        if (event.type === "users_state") {
          return Object.fromEntries(states.map((item) => [item.publicID, item.online]));
        }
        const updated = { ...current };
        for (const item of states) updated[item.publicID] = item.online;
        return updated;
      });
      setPresenceReady(true);
      return;
    }
    const senderPublicID = event.fromUserPublicID;
    if (!senderPublicID) return;
    const recipient = selectedRef.current;
    const peerPublicID = event.conversationPublicID;
    const canonical = event.message;
    const reaction = event.detail?.type === "reaction";
    const incoming = senderPublicID !== user?.publicID;
    const selectedConversation = Boolean(
      open && recipient && peerPublicID && recipient.publicID === peerPublicID,
    );

    if (canonical && peerPublicID) {
      if (selectedConversation) {
        const previousMaximum = messagesRef.current.reduce(
          (maximum, item) => Math.max(maximum, item.id),
          0,
        );
        if (!reaction && canonical.id > previousMaximum) {
          if (nearMessageBottomRef.current) {
            pendingMessageScrollRef.current = { mode: "bottom", behavior: "smooth" };
          } else if (incoming) {
            setNewMessagesBelow(true);
          }
        }
        setMessages((current) => mergeMessages(current, [canonical]));
        if (incoming) syncReadState(peerPublicID, canonical.id);
      } else if (incoming && !reaction) {
        setUnreadByUser((current) => ({
          ...current,
          [peerPublicID]: Math.min(99, (current[peerPublicID] || 0) + 1),
        }));
        setTotalUnread((current) => current + 1);
      }
      scheduleConversationRefresh();
    } else {
      // Older servers or a transient indexing failure may omit canonical data.
      // Merge an event storm into one bounded history/conversation refresh.
      if (open && recipient && !messageRefreshTimerRef.current) {
        messageRefreshTimerRef.current = window.setTimeout(() => {
          messageRefreshTimerRef.current = null;
          const currentRecipient = selectedRef.current;
          if (currentRecipient) void loadMessages(currentRecipient);
        }, 150);
      }
      scheduleConversationRefresh();
      return;
    }

    if (!incoming || reaction || selectedConversation) return;

    const previousConversation = conversations.find(
      (item) => item.user.publicID === peerPublicID,
    );
    // A missing durable preference is treated as muted. This avoids leaking a
    // notification for the first event of an unknown/muted conversation while
    // the already-debounced conversation refresh catches up.
    if (!previousConversation || previousConversation.muted) return;
    const sender =
      previousConversation.user || users.find((item) => item.publicID === peerPublicID);
    if (
      notificationsEnabled &&
      document.visibilityState !== "visible" &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      new Notification(sender ? displayName(sender) : t("title"), {
        body:
          event.detail?.content_type === "vocechat/file"
            ? t("notifications.file")
            : event.detail?.content || t("notifications.message"),
      });
    }
  }, (connected) => {
    if (!connected) setPresenceReady(false);
  });

  const selectUser = (next: InternalMessagingUser) => {
    messageRequestRef.current.controller?.abort();
    messageRequestRef.current = {
      sequence: messageRequestRef.current.sequence + 1,
      controller: null,
    };
    const cached = messageCacheRef.current.get(next.publicID);
    setSelected(next);
    setMessages(cached?.messages || []);
    setHasMoreMessages(cached?.hasMore || false);
    setNextBefore(cached?.nextBefore || 0);
    setLoadingMessages(false);
    setLoadingOlderMessages(false);
    setMessageError("");
    setActionError("");
    setNewMessagesBelow(false);
    nearMessageBottomRef.current = true;
    pendingMessageScrollRef.current = cached
      ? { mode: "bottom", behavior: "auto" }
      : null;
    setMessageSearchOpen(false);
    setMessageSearchQuery("");
    setMessageSearchResults([]);
    setReplyTo(null);
    setEditing(null);
    const cleared = unreadByUser[next.publicID] || 0;
    setUnreadByUser((current) => {
      if (!current[next.publicID]) return current;
      const updated = { ...current };
      delete updated[next.publicID];
      return updated;
    });
    if (cleared) setTotalUnread((total) => Math.max(0, total - cleared));
  };

  const toggleNotifications = async () => {
    if (!user?.publicID || !browserNotificationsAllowed || !("Notification" in window)) return;
    let next = !notificationsEnabled;
    if (next && Notification.permission !== "granted") {
      next = (await Notification.requestPermission()) === "granted";
    }
    setNotificationsEnabled(next);
    window.localStorage.setItem(
      `${NOTIFICATION_STORAGE_PREFIX}:${user.publicID}`,
      String(next),
    );
  };

  const updateConversationPreference = async (
    conversation: InternalMessagingConversation,
    preferences: { pinned?: boolean; muted?: boolean },
  ) => {
    setActionError("");
    try {
      await updateInternalMessagingPreferences(
        accessToken,
        conversation.user.publicID,
        preferences,
      );
      await loadConversations();
    } catch {
      setActionError(t("errors.preferences"));
    }
  };

  const searchMessages = async () => {
    if (!selected || !messageSearchQuery.trim()) return;
    const recipientPublicID = selected.publicID;
    const searchQuery = messageSearchQuery.trim();
    setSearchingMessages(true);
    setActionError("");
    try {
      const result = await searchInternalMessagingMessages(
        accessToken,
        searchQuery,
        recipientPublicID,
      );
      if (selectedRef.current?.publicID !== recipientPublicID) return;
      setMessageSearchResults(mergeMessages(result.results));
    } catch {
      if (selectedRef.current?.publicID === recipientPublicID) {
        setActionError(t("errors.search"));
      }
    } finally {
      setSearchingMessages(false);
    }
  };

  const close = () => {
    messageRequestRef.current.controller?.abort();
    messageRequestRef.current = {
      sequence: messageRequestRef.current.sequence + 1,
      controller: null,
    };
    setOpen(false);
    setSelected(null);
    setMessageSearchOpen(false);
    setReplyTo(null);
    setEditing(null);
    setMessageError("");
    setActionError("");
    setNewMessagesBelow(false);
    nearMessageBottomRef.current = true;
    pendingMessageScrollRef.current = null;
  };

  const send = async () => {
    if (!selected || !draft.trim() || sending) return;
    const recipientPublicID = selected.publicID;
    const content = draft.trim();
    setSending(true);
    setDraft("");
    setActionError("");
    try {
      if (editing) {
        const message = await editInternalMessagingMessage(accessToken, editing.id, content);
        if (selectedRef.current?.publicID === recipientPublicID) {
          setMessages((items) =>
            mergeMessages(items.map((item) => (item.id === message.id ? message : item))),
          );
          setEditing(null);
        }
      } else {
        const message = replyTo
          ? await replyInternalMessagingMessage(accessToken, recipientPublicID, replyTo.id, content)
          : await sendInternalMessagingMessage(accessToken, recipientPublicID, content);
        if (selectedRef.current?.publicID === recipientPublicID) {
          pendingMessageScrollRef.current = { mode: "bottom", behavior: "smooth" };
          setMessages((items) => mergeMessages(items, [message]));
          setReplyTo(null);
        }
      }
      void loadConversations();
    } catch {
      if (selectedRef.current?.publicID === recipientPublicID) {
        setDraft(content);
        setActionError(editing ? t("errors.edit") : t("errors.send"));
      }
    } finally {
      setSending(false);
    }
  };

  const chooseEdit = (message: InternalMessagingMessage) => {
    setEditing(message);
    setReplyTo(null);
    setDraft(message.content);
  };

  const removeMessage = async (message: InternalMessagingMessage) => {
    if (!window.confirm(t("messages.confirmDelete"))) return;
    const recipientPublicID = selected?.publicID;
    setActionError("");
    try {
      await deleteInternalMessagingMessage(accessToken, message.id);
      if (selectedRef.current?.publicID !== recipientPublicID) return;
      setMessages((items) =>
        mergeMessages(
          items.map((item) =>
            item.id === message.id
              ? { ...item, content: "", file: undefined, deleted: true }
              : item,
          ),
        ),
      );
      if (editing?.id === message.id) {
        setEditing(null);
        setDraft("");
      }
      void loadConversations();
    } catch {
      if (selectedRef.current?.publicID === recipientPublicID) {
        setActionError(t("errors.delete"));
      }
    }
  };

  const uploadFile = async (file: File) => {
    if (!selected || uploading) return;
    const recipientPublicID = selected.publicID;
    if (file.size > maxFileBytes) {
      setActionError(
        t("file.tooLarge", {
          size: formatFileSize(maxFileBytes, locale, t("file.unknownSize")),
        }),
      );
      return;
    }
    setUploading(true);
    setActionError("");
    try {
      const message = await sendInternalMessagingFile(accessToken, recipientPublicID, file);
      if (selectedRef.current?.publicID === recipientPublicID) {
        pendingMessageScrollRef.current = { mode: "bottom", behavior: "smooth" };
        setMessages((items) => mergeMessages(items, [message]));
      }
      void loadConversations();
    } catch {
      if (selectedRef.current?.publicID === recipientPublicID) {
        setActionError(t("errors.fileSend"));
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const pasteFile = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (editing || uploading) return;
    const image = [...event.clipboardData.files].find((file) => file.type.startsWith("image/"));
    if (!image) return;
    event.preventDefault();
    void uploadFile(image);
  };

  const dropFile = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDraggingFile(false);
    if (editing || uploading) return;
    const file = event.dataTransfer.files[0];
    if (file) void uploadFile(file);
  };

  const insertEmoji = (emoji: string) => {
    const composer = composerRef.current;
    const start = composer?.selectionStart ?? draft.length;
    const end = composer?.selectionEnd ?? draft.length;
    const next = `${draft.slice(0, start)}${emoji}${draft.slice(end)}`;
    setDraft(next);
    setEmojiPickerOpen(false);
    window.setTimeout(() => {
      composer?.focus();
      composer?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  };

  const focusSearchResult = async (result: InternalMessagingMessage) => {
    let merged = messages;
    if (!messages.some((item) => item.id === result.id) && selected) {
      const recipientPublicID = selected.publicID;
      setActionError("");
      try {
        const page = await listInternalMessagingMessages(
          accessToken,
          recipientPublicID,
          result.id + 1,
        );
        if (selectedRef.current?.publicID !== recipientPublicID) return;
        merged = mergeMessages(page.results, messages);
        setMessages(merged);
      } catch {
        if (selectedRef.current?.publicID === recipientPublicID) {
          setActionError(t("errors.locate"));
        }
        return;
      }
    }
    setMessageSearchOpen(false);
    window.setTimeout(() => {
      document.getElementById(`internal-message-${result.id}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
  };

  const startButtonDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (mobileLayout || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    buttonDragRef.current = {
      pointerID: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { x: rect.left, y: rect.top },
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveButton = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = buttonDragRef.current;
    if (!drag || drag.pointerID !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 3) drag.moved = true;
    setButtonPoint(clampButtonPoint({ x: drag.origin.x + deltaX, y: drag.origin.y + deltaY }));
  };

  const stopButtonDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = buttonDragRef.current;
    if (!drag || drag.pointerID !== event.pointerId) return;
    suppressButtonClickRef.current = drag.moved;
    buttonDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const openFromButton = () => {
    if (suppressButtonClickRef.current) {
      suppressButtonClickRef.current = false;
      return;
    }
    setOpen(true);
  };

  const startWindowDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (
      mobileLayout ||
      event.button !== 0 ||
      (event.target as HTMLElement).closest("button")
    ) {
      return;
    }
    windowDragRef.current = {
      pointerID: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { x: windowBounds.x, y: windowBounds.y },
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveWindow = (event: React.PointerEvent<HTMLElement>) => {
    const drag = windowDragRef.current;
    if (!drag || drag.pointerID !== event.pointerId) return;
    setWindowBounds((current) =>
      clampWindowBounds({
        ...current,
        x: drag.origin.x + event.clientX - drag.startX,
        y: drag.origin.y + event.clientY - drag.startY,
      }),
    );
  };

  const stopWindowDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = windowDragRef.current;
    if (!drag || drag.pointerID !== event.pointerId) return;
    windowDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const direction = event.currentTarget.dataset.direction as ResizeDirection;
    resizeRef.current = {
      pointerID: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      direction,
      bounds: windowBounds,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const resizeWindow = (event: React.PointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerID !== event.pointerId) return;
    const deltaX = event.clientX - resize.startX;
    const deltaY = event.clientY - resize.startY;
    const minimumWidth = Math.min(
      MIN_WINDOW_WIDTH,
      window.innerWidth - VIEWPORT_MARGIN * 2,
    );
    const minimumHeight = Math.min(
      MIN_WINDOW_HEIGHT,
      window.innerHeight - VIEWPORT_MARGIN * 2,
    );
    let left = resize.bounds.x;
    let right = resize.bounds.x + resize.bounds.width;
    let top = resize.bounds.y;
    let bottom = resize.bounds.y + resize.bounds.height;

    if (resize.direction.includes("e")) {
      right = clamp(
        right + deltaX,
        left + minimumWidth,
        window.innerWidth - VIEWPORT_MARGIN,
      );
    }
    if (resize.direction.includes("w")) {
      left = clamp(left + deltaX, VIEWPORT_MARGIN, right - minimumWidth);
    }
    if (resize.direction.includes("s")) {
      bottom = clamp(
        bottom + deltaY,
        top + minimumHeight,
        window.innerHeight - VIEWPORT_MARGIN,
      );
    }
    if (resize.direction.includes("n")) {
      top = clamp(top + deltaY, VIEWPORT_MARGIN, bottom - minimumHeight);
    }

    setWindowBounds({ x: left, y: top, width: right - left, height: bottom - top });
  };

  const stopResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerID !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (!enabled || !user) return null;

  return (
    <>
      {open ? (
        <aside
          className={cn(
            "fixed z-[70] flex min-h-0 flex-col overflow-hidden bg-background shadow-2xl overscroll-contain",
            mobileLayout ? "inset-0 rounded-none border-0" : "rounded-2xl border",
          )}
          style={
            mobileLayout
              ? { width: "100%", height: "100dvh" }
              : {
                  left: windowBounds.x,
                  top: windowBounds.y,
                  width: windowBounds.width,
                  height: windowBounds.height,
                }
          }
        >
          <header
            className={cn(
              "flex min-h-14 shrink-0 select-none items-center gap-2 border-b px-3",
              mobileLayout
                ? "cursor-default touch-auto pt-[env(safe-area-inset-top)]"
                : "h-14 cursor-move touch-none",
            )}
            onPointerDown={startWindowDrag}
            onPointerMove={moveWindow}
            onPointerUp={stopWindowDrag}
            onPointerCancel={stopWindowDrag}
          >
            {selected ? (
              <Button
                aria-label={t("aria.back")}
                variant="ghost"
                size="icon-sm"
                onClick={() => setSelected(null)}
              >
                <ChevronLeft />
              </Button>
            ) : (
              <MessageCircle className="size-4 text-primary" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {selected ? displayName(selected) : t("title")}
              </p>
              <p className="truncate text-[11px] text-muted-foreground">
                {selected
                  ? presenceReady
                    ? `${selected.username} · ${t(onlineByUser[selected.publicID] ? "presence.online" : "presence.offline")}`
                    : selected.username
                  : t(mobileLayout ? "mobileHint" : "dragHint")}
              </p>
            </div>
            {selected ? (
              <Button
                aria-label={t("aria.search")}
                variant="ghost"
                size="icon-sm"
                onClick={() => setMessageSearchOpen((current) => !current)}
              >
                <Search />
              </Button>
            ) : null}
            <Button
              aria-label={
                notificationsEnabled ? t("aria.notificationsOn") : t("aria.notificationsOff")
              }
              variant="ghost"
              size="icon-sm"
              disabled={!browserNotificationsAllowed}
              onClick={() => void toggleNotifications()}
            >
              {notificationsEnabled ? <Bell /> : <BellOff />}
            </Button>
            <Button aria-label={t("aria.close")} variant="ghost" size="icon-sm" onClick={close}>
              <X />
            </Button>
          </header>

          {actionError ? (
            <div
              role="alert"
              className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              <span className="min-w-0 flex-1">{actionError}</span>
              <button
                type="button"
                aria-label={t("aria.dismissError")}
                className="rounded p-0.5 hover:bg-destructive/10"
                onClick={() => setActionError("")}
              >
                <X className="size-3" />
              </button>
            </div>
          ) : null}

          {selected ? (
            <div
              className="relative flex min-h-0 flex-1 flex-col"
              onDragEnter={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                setDraggingFile(true);
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                setDraggingFile(false);
              }}
              onDrop={dropFile}
            >
              {messageSearchOpen ? (
                <div className="border-b p-2">
                  <div className="flex gap-2">
                    <Input
                      value={messageSearchQuery}
                      onChange={(event) => setMessageSearchQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void searchMessages();
                      }}
                      placeholder={t("search.placeholder")}
                    />
                    <Button
                      size="sm"
                      disabled={!messageSearchQuery.trim() || searchingMessages}
                      onClick={() => void searchMessages()}
                    >
                      {searchingMessages ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        t("search.action")
                      )}
                    </Button>
                  </div>
                  {messageSearchResults.length > 0 ? (
                    <div className="mt-2 max-h-32 space-y-1 overflow-y-auto">
                      {messageSearchResults.map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-accent"
                          onClick={() => void focusSearchResult(item)}
                        >
                          {item.content}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div
                ref={messageViewportRef}
                className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 overscroll-contain"
                onScroll={handleMessageScroll}
              >
                {messageError && messages.length > 0 ? (
                  <p
                    role="alert"
                    className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
                  >
                    {messageError}
                  </p>
                ) : null}
                {hasMoreMessages ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    disabled={loadingOlderMessages}
                    onClick={() => void loadMessages(selected, nextBefore)}
                  >
                    {loadingOlderMessages ? t("messages.loading") : t("messages.loadOlder")}
                  </Button>
                ) : null}
                {loadingMessages && messages.length === 0 ? (
                  <Loading />
                ) : messages.length === 0 ? (
                  <Empty label={messageError || t("messages.empty")} />
                ) : (
                  messages.map((message) => {
                    const mine = message.fromUserPublicID === user.publicID;
                    return (
                      <div
                        key={message.id}
                        id={`internal-message-${message.id}`}
                        className={cn("flex", mine ? "justify-end" : "justify-start")}
                        style={{ contentVisibility: "auto", containIntrinsicSize: "auto 72px" }}
                      >
                        <div
                          className={cn(
                            "group/message relative max-w-[85%] rounded-2xl px-3 py-2 text-sm",
                            mine ? "bg-primary text-primary-foreground" : "bg-muted",
                          )}
                        >
                          {message.replyToID > 0 ? (
                            <div
                              className={cn(
                                "mb-1 border-l-2 pl-2 text-xs opacity-75",
                                mine ? "border-primary-foreground/50" : "border-foreground/30",
                              )}
                            >
                              {messageByID.get(message.replyToID)?.content ||
                                t("messages.olderReply")}
                            </div>
                          ) : null}
                          <MessageRenderBoundary
                            key={`${message.id}:${message.editedAt}:${message.deleted}`}
                            fallback={
                              <p className="italic opacity-70">{t("messages.renderError")}</p>
                            }
                          >
                            {message.deleted ? (
                              <p className="italic opacity-70">{t("messages.deleted")}</p>
                            ) : message.file ? (
                              <MessageFile
                                accessToken={accessToken}
                                message={message}
                                onError={() => setActionError(t("errors.fileDownload"))}
                                onContentResize={maintainMessageBottom}
                                onPreview={() => setPreviewMessage(message)}
                              />
                            ) : (
                              <StreamdownRender
                                content={safeInternalMessageMarkdown(message.content)}
                                streaming={false}
                                variant="user"
                                className={cn(
                                  "break-words text-sm [&_a]:underline [&_a]:underline-offset-2 [&_p]:my-0",
                                  mine &&
                                    "text-primary-foreground [&_a]:text-primary-foreground",
                                )}
                              />
                            )}
                          </MessageRenderBoundary>
                          <p
                            className={cn(
                              "mt-1 text-[10px]",
                              mine ? "text-primary-foreground/70" : "text-muted-foreground",
                            )}
                          >
                            {message.editedAt ? t("messages.edited") : ""}
                            {formatTime(message.createdAt, locale)}
                          </p>
                          {!message.deleted ? (
                            <span
                            className={cn(
                                "absolute -top-3 hidden items-center rounded-full border bg-background text-foreground shadow-sm group-hover/message:flex max-sm:flex",
                                mine ? "right-1" : "left-1",
                            )}
                          >
                              {message.content ? (
                                <MessageAction label={t("messages.copy")} onClick={() => void navigator.clipboard.writeText(message.content)}>
                                  <Clipboard className="size-3" />
                                </MessageAction>
                              ) : null}
                              <MessageAction label={t("messages.reply")} onClick={() => { setReplyTo(message); setEditing(null); }}>
                                <CornerUpLeft className="size-3" />
                              </MessageAction>
                              {mine && !message.file ? (
                                <MessageAction label={t("messages.edit")} onClick={() => chooseEdit(message)}>
                                  <Pencil className="size-3" />
                                </MessageAction>
                              ) : null}
                              {mine ? (
                                <MessageAction label={t("messages.delete")} onClick={() => void removeMessage(message)}>
                                  <Trash2 className="size-3" />
                                </MessageAction>
                              ) : null}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
              {newMessagesBelow ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="absolute bottom-20 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-lg"
                  onClick={() => scrollToMessageBottom("smooth")}
                >
                  <ChevronDown className="size-3" />
                  {t("messages.newBelow")}
                </Button>
              ) : null}
              <div className="border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                {replyTo || editing ? (
                  <div className="mb-2 flex items-center gap-2 rounded-md bg-muted px-2 py-1 text-xs">
                    {editing ? <Pencil className="size-3" /> : <CornerUpLeft className="size-3" />}
                    <span className="min-w-0 flex-1 truncate">
                      {editing
                        ? t("composer.editing")
                        : t("composer.replying", {
                            content:
                              replyTo?.content || replyTo?.file?.name || t("composer.file"),
                          })}
                    </span>
                    <button
                      type="button"
                      aria-label={t("aria.cancelAction")}
                      onClick={() => {
                        setReplyTo(null);
                        setEditing(null);
                        if (editing) setDraft("");
                      }}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ) : null}
                <div className="flex items-end gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void uploadFile(file);
                    }}
                  />
                  <Button
                    aria-label={t("aria.attach")}
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={uploading || sending || Boolean(editing)}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {uploading ? <LoaderCircle className="animate-spin" /> : <Paperclip />}
                  </Button>
                  <Popover open={emojiPickerOpen} onOpenChange={setEmojiPickerOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        aria-label={t("aria.emoji")}
                        type="button"
                        variant="ghost"
                        size="icon"
                      >
                        <Smile />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      side="top"
                      align="start"
                      className="grid w-64 grid-cols-8 gap-1 p-2"
                    >
                      {COMMON_EMOJIS.map((emoji) => (
                        <button
                          type="button"
                          key={emoji}
                          className="flex size-7 items-center justify-center rounded text-lg hover:bg-accent"
                          onClick={() => insertEmoji(emoji)}
                        >
                          {emoji}
                        </button>
                      ))}
                    </PopoverContent>
                  </Popover>
                  <Textarea
                    ref={composerRef}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onPaste={pasteFile}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                    placeholder={t("composer.placeholder")}
                    className="max-h-28 min-h-10 resize-none text-base sm:text-sm"
                  />
                  <Button
                    aria-label={t("aria.send")}
                    size="icon"
                    disabled={!draft.trim() || sending}
                    onClick={() => void send()}
                  >
                    {sending ? <LoaderCircle className="animate-spin" /> : editing ? <Check /> : <Send />}
                  </Button>
                </div>
              </div>
              {draggingFile ? (
                <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/90 text-sm font-medium text-primary backdrop-blur-sm">
                  {t("composer.dropFile")}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="space-y-2 border-b p-3">
                <div className="grid grid-cols-2 rounded-lg bg-muted p-1">
                  <button
                    type="button"
                    className={cn(
                      "rounded-md px-2 py-1 text-xs",
                      directoryView === "recent" && "bg-background font-medium shadow-sm",
                    )}
                    onClick={() => setDirectoryView("recent")}
                  >
                    {t("directory.recent")}
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "rounded-md px-2 py-1 text-xs",
                      directoryView === "users" && "bg-background font-medium shadow-sm",
                    )}
                    onClick={() => setDirectoryView("users")}
                  >
                    {t("directory.allUsers")}
                  </button>
                </div>
                {directoryView === "users" ? (
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={t("directory.searchPlaceholder")}
                      className="pl-8"
                    />
                  </div>
                ) : null}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {directoryView === "recent" ? (
                  conversations.length === 0 ? (
                    <Empty label={t("directory.noRecent")} />
                  ) : (
                    conversations.map((conversation) => {
                      const item = conversation.user;
                      const unread = unreadByUser[item.publicID] || conversation.unreadCount;
                      return (
                        <div
                          key={item.publicID}
                          className="group/conversation flex items-center rounded-lg hover:bg-accent"
                        >
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-3 p-2 text-left"
                            onClick={() => selectUser(item)}
                            onPointerEnter={() => prefetchMessages(item)}
                            onFocus={() => prefetchMessages(item)}
                            onTouchStart={() => prefetchMessages(item)}
                          >
                            <span className="relative shrink-0">
                              <Avatar>
                                <AvatarImage src={item.avatarURL || undefined} />
                                <AvatarFallback>{initials(displayName(item))}</AvatarFallback>
                              </Avatar>
                              {presenceReady ? (
                                <PresenceIndicator
                                  online={Boolean(onlineByUser[item.publicID])}
                                  label={t(
                                    onlineByUser[item.publicID]
                                      ? "presence.online"
                                      : "presence.offline",
                                  )}
                                />
                              ) : null}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1">
                                <span className="truncate text-sm font-medium">
                                  {displayName(item)}
                                </span>
                                {conversation.pinned ? <Pin className="size-3 text-primary" /> : null}
                                {conversation.muted ? (
                                  <VolumeX className="size-3 text-muted-foreground" />
                                ) : null}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {conversation.lastMessagePreview || t("directory.start")}
                              </span>
                            </span>
                            <span className="flex shrink-0 flex-col items-end gap-1">
                              <span className="text-[10px] text-muted-foreground">
                                {formatTime(conversation.lastMessageAt, locale)}
                              </span>
                              {unread > 0 ? (
                                <span className="flex min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-destructive-foreground">
                                  {unread > 99 ? "99+" : unread}
                                </span>
                              ) : null}
                            </span>
                          </button>
                          <span className="mr-1 hidden shrink-0 group-hover/conversation:flex max-sm:flex">
                            <button
                              type="button"
                              aria-label={
                                conversation.pinned ? t("aria.unpin") : t("aria.pin")
                              }
                              className="rounded p-1 hover:bg-background"
                              onClick={() =>
                                void updateConversationPreference(conversation, {
                                  pinned: !conversation.pinned,
                                })
                              }
                            >
                              <Pin className="size-3" />
                            </button>
                            <button
                              type="button"
                              aria-label={
                                conversation.muted ? t("aria.unmute") : t("aria.mute")
                              }
                              className="rounded p-1 hover:bg-background"
                              onClick={() =>
                                void updateConversationPreference(conversation, {
                                  muted: !conversation.muted,
                                })
                              }
                            >
                              {conversation.muted ? (
                                <Volume2 className="size-3" />
                              ) : (
                                <VolumeX className="size-3" />
                              )}
                            </button>
                          </span>
                        </div>
                      );
                    })
                  )
                ) : loadingUsers && users.length === 0 ? (
                  <Loading />
                ) : users.length === 0 ? (
                  <Empty label={directoryError || t("directory.noUsers")} />
                ) : (
                  <>
                    {directoryError ? (
                      <p
                        role="alert"
                        className="mb-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
                      >
                        {directoryError}
                      </p>
                    ) : null}
                    {users.map((item) => {
                      const unread = unreadByUser[item.publicID] || 0;
                      return (
                        <button
                          type="button"
                          key={item.publicID}
                          className="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-accent"
                          onClick={() => selectUser(item)}
                          onPointerEnter={() => prefetchMessages(item)}
                          onFocus={() => prefetchMessages(item)}
                          onTouchStart={() => prefetchMessages(item)}
                        >
                          <span className="relative shrink-0">
                            <Avatar>
                              <AvatarImage src={item.avatarURL || undefined} />
                              <AvatarFallback>{initials(displayName(item))}</AvatarFallback>
                            </Avatar>
                            {presenceReady ? (
                              <PresenceIndicator
                                online={Boolean(onlineByUser[item.publicID])}
                                label={t(
                                  onlineByUser[item.publicID]
                                    ? "presence.online"
                                    : "presence.offline",
                                )}
                              />
                            ) : null}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {displayName(item)}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {item.username}
                            </span>
                          </span>
                          {unread > 0 ? (
                            <span className="flex min-w-5 shrink-0 items-center justify-center rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-destructive-foreground">
                              {unread > 99 ? "99+" : unread}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                    {hasMoreUsers ? (
                      <Button
                        variant="ghost"
                        className="mt-1 w-full"
                        disabled={loadingUsers}
                        onClick={() => void loadUsers(directoryPage + 1, true)}
                      >
                        {loadingUsers ? t("messages.loading") : t("directory.loadMore")}
                      </Button>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          )}

          {!mobileLayout
            ? RESIZE_HANDLES.map(({ direction, className }) => (
                <button
                  aria-label={t("aria.resize", { direction })}
                  type="button"
                  tabIndex={-1}
                  key={direction}
                  data-direction={direction}
                  className={cn(
                    "absolute z-10 touch-none border-0 bg-transparent p-0",
                    className,
                  )}
                  onPointerDown={startResize}
                  onPointerMove={resizeWindow}
                  onPointerUp={stopResize}
                  onPointerCancel={stopResize}
                />
              ))
            : null}
        </aside>
      ) : null}

      {previewMessage ? (
        <ImageLightbox
          accessToken={accessToken}
          message={previewMessage}
          onClose={() => setPreviewMessage(null)}
          onError={() => setActionError(t("errors.fileDownload"))}
        />
      ) : null}

      <Button
        aria-label={t("aria.open")}
        className={cn(
          "fixed z-[69] size-11 rounded-full shadow-lg",
          mobileLayout
            ? "touch-manipulation cursor-pointer"
            : "touch-none cursor-grab active:cursor-grabbing",
          open && "hidden",
        )}
        style={
          mobileLayout
            ? {
                right: "max(16px, env(safe-area-inset-right))",
                bottom: "max(16px, env(safe-area-inset-bottom))",
              }
            : buttonPoint
              ? { left: buttonPoint.x, top: buttonPoint.y }
              : { right: 20, bottom: 20 }
        }
        size="icon"
        onPointerDown={startButtonDrag}
        onPointerMove={moveButton}
        onPointerUp={stopButtonDrag}
        onPointerCancel={stopButtonDrag}
        onClick={openFromButton}
      >
        <MessageCircle className="size-5" />
        {totalUnread > 0 ? (
          <span className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] text-destructive-foreground">
            {totalUnread > 99 ? "99+" : totalUnread}
          </span>
        ) : null}
      </Button>
    </>
  );
}

function Loading() {
  const t = useTranslations("internalMessaging");
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      <LoaderCircle className="mr-2 size-4 animate-spin" />
      {t("messages.loading")}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
      {label}
    </div>
  );
}

function PresenceIndicator({ online, label }: { online: boolean; label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "absolute bottom-0 right-0 size-3 rounded-full border-2 border-background",
        online ? "bg-emerald-500" : "bg-muted-foreground/50",
      )}
    />
  );
}

function MessageAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="rounded-full p-1.5 hover:bg-accent"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function MessageFile({
  accessToken,
  message,
  onError,
  onContentResize,
  onPreview,
}: {
  accessToken: string;
  message: InternalMessagingMessage;
  onError: () => void;
  onContentResize: () => void;
  onPreview: () => void;
}) {
  const t = useTranslations("internalMessaging");
  const locale = useLocale();
  const [imageURL, setImageURL] = React.useState("");
  const [shouldLoadImage, setShouldLoadImage] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const file = message.file;
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;

  React.useEffect(() => {
    if (!file?.image || shouldLoadImage) return;
    const element = containerRef.current;
    if (!element || !("IntersectionObserver" in window)) {
      setShouldLoadImage(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShouldLoadImage(true);
        observer.disconnect();
      },
      { rootMargin: "320px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [file?.image, shouldLoadImage]);

  React.useEffect(() => {
    if (!file?.image || !shouldLoadImage) return;
    let disposed = false;
    let objectURL = "";
    void downloadInternalMessagingFile(accessToken, message.id, { thumbnail: true })
      .then((blob) => {
        if (disposed) return;
        objectURL = URL.createObjectURL(blob);
        setImageURL(objectURL);
      })
      .catch(() => {
        if (!disposed) onErrorRef.current();
      });
    return () => {
      disposed = true;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [accessToken, file?.image, message.id, shouldLoadImage]);

  if (!file) return null;

  const download = async () => {
    try {
      const blob = await downloadInternalMessagingFile(accessToken, message.id, { download: true });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      onError();
    }
  };

  return (
    <div ref={containerRef} className="block max-w-full text-left">
      {file.image && imageURL ? (
        <button type="button" className="group/image relative block" onClick={onPreview}>
          <img
            src={imageURL}
            loading="lazy"
            className="mb-1 max-h-56 max-w-full rounded-lg object-contain"
            alt={file.name}
            onLoad={onContentResize}
          />
          <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/0 opacity-0 transition group-hover/image:bg-black/25 group-hover/image:opacity-100">
            <Maximize2 className="size-5 text-white drop-shadow" />
          </span>
        </button>
      ) : (
        <button type="button" className="flex items-center gap-2" onClick={() => void download()}>
          <FileIcon className="size-8 shrink-0" />
          <span className="min-w-0">
            <span className="block truncate font-medium">{file.name}</span>
            <span className="block text-xs opacity-70">
              {formatFileSize(file.size, locale, t("file.unknownSize"))}
            </span>
          </span>
          <Download className="size-4 shrink-0" />
        </button>
      )}
      {file.image && imageURL ? (
        <button
          type="button"
          className="flex w-full items-center gap-1 text-xs opacity-75"
          onClick={() => void download()}
        >
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          <Download className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

function ImageLightbox({
  accessToken,
  message,
  onClose,
  onError,
}: {
  accessToken: string;
  message: InternalMessagingMessage;
  onClose: () => void;
  onError: () => void;
}) {
  const t = useTranslations("internalMessaging");
  const [imageURL, setImageURL] = React.useState("");
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;

  React.useEffect(() => {
    let disposed = false;
    let objectURL = "";
    void downloadInternalMessagingFile(accessToken, message.id)
      .then((blob) => {
        if (disposed) return;
        objectURL = URL.createObjectURL(blob);
        setImageURL(objectURL);
      })
      .catch(() => {
        if (!disposed) onErrorRef.current();
      });
    return () => {
      disposed = true;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [accessToken, message.id]);

  React.useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("aria.imagePreview")}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4"
    >
      <button
        type="button"
        aria-label={t("aria.closePreview")}
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <button
        type="button"
        aria-label={t("aria.closePreview")}
        className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] z-10 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
        onClick={onClose}
      >
        <X className="size-5" />
      </button>
      {imageURL ? (
        <img
          src={imageURL}
          alt={message.file?.name || ""}
          className="relative max-h-full max-w-full object-contain"
        />
      ) : (
        <LoaderCircle className="size-8 animate-spin text-white" />
      )}
    </div>
  );
}

function formatFileSize(bytes: number, locale: string, unknownSize: string) {
  if (!Number.isFinite(bytes) || bytes <= 0) return unknownSize;
  const format = (value: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${format(bytes / 1024)} KB`;
  return `${format(bytes / 1024 / 1024)} MB`;
}
