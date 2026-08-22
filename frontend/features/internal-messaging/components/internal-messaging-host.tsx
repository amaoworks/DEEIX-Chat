"use client";

import * as React from "react";
import {
  Bell,
  BellOff,
  Check,
  ChevronLeft,
  Clipboard,
  CornerUpLeft,
  Download,
  FileIcon,
  LoaderCircle,
  MessageCircle,
  Paperclip,
  Pencil,
  Pin,
  Search,
  Send,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
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
type MessagingEvent = {
  type?: string;
  mid?: number;
  fromUserPublicID?: string;
  detail?: {
    type?: string;
    content?: string;
    content_type?: string;
    mid?: number;
    detail?: { type?: string; content?: string };
  };
};

const VIEWPORT_MARGIN = 8;
const BUTTON_SIZE = 44;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 360;
const LAYOUT_STORAGE_PREFIX = "deeix.internal-messaging.layout.v1";
const NOTIFICATION_STORAGE_PREFIX = "deeix.internal-messaging.notifications.v1";

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

function mergeMessages(
  ...groups: InternalMessagingMessage[][]
): InternalMessagingMessage[] {
  const byID = new Map<number, InternalMessagingMessage>();
  for (const group of groups) {
    for (const message of group) byID.set(message.id, message);
  }
  return [...byID.values()].sort((left, right) => left.id - right.id);
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
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

function useMessagingEvents(
  enabled: boolean,
  accessToken: string,
  onEvent: (event: MessagingEvent) => void,
) {
  const latestMID = React.useRef(0);
  const callback = React.useRef(onEvent);
  callback.current = onEvent;

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
              if (payload.type === "chat") callback.current(payload);
            } catch {
              // Heartbeats and non-JSON events still indicate a live connection.
            }
          }
        }
      } catch {
        // The next retry also covers temporary VoceChat unavailability.
      }
      if (!cancelled) retryTimer = setTimeout(connect, 1500);
    };
    void connect();
    return () => {
      cancelled = true;
      controller?.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [accessToken, enabled]);
}

export function InternalMessagingHost() {
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
  const [error, setError] = React.useState("");
  const [buttonPoint, setButtonPoint] = React.useState<Point | null>(null);
  const [windowBounds, setWindowBounds] = React.useState<WindowBounds>(initialWindowBounds);
  const selectedRef = React.useRef<InternalMessagingUser | null>(null);
  const buttonDragRef = React.useRef<DragSnapshot | null>(null);
  const windowDragRef = React.useRef<DragSnapshot | null>(null);
  const resizeRef = React.useRef<ResizeSnapshot | null>(null);
  const suppressButtonClickRef = React.useRef(false);
  const layoutHydratedRef = React.useRef(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  selectedRef.current = selected;

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

  const loadUsers = React.useCallback(
    async (page = 1, append = false) => {
      if (!enabled) return;
      setLoadingUsers(true);
      setError("");
      try {
        const result = await listInternalMessagingUsers(accessToken, query, page);
        setUsers((items) => (append ? [...items, ...result.results] : result.results));
        setDirectoryPage(page);
        setHasMoreUsers(result.hasMore);
      } catch {
        setError("聊天服务暂不可用，请稍后重试。");
      } finally {
        setLoadingUsers(false);
      }
    },
    [accessToken, enabled, query],
  );

  const loadMessages = React.useCallback(
    async (recipient: InternalMessagingUser, before = 0) => {
      if (before) setLoadingOlderMessages(true);
      else setLoadingMessages(true);
      setError("");
      try {
        const page = await listInternalMessagingMessages(
          accessToken,
          recipient.publicID,
          before || undefined,
        );
        const next = mergeMessages(page.results);
        setMessages((current) => {
          if (!before) return next;
          return mergeMessages(next, current);
        });
        setHasMoreMessages(page.hasMore);
        setNextBefore(page.nextBefore);
        if (!before) {
          const throughMID = next.reduce((maximum, item) => Math.max(maximum, item.id), 0);
          await markInternalMessagingRead(accessToken, recipient.publicID, throughMID);
          await loadConversations();
        }
      } catch {
        setError("消息暂时无法加载。");
      } finally {
        if (before) setLoadingOlderMessages(false);
        else setLoadingMessages(false);
      }
    },
    [accessToken, loadConversations],
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

  useMessagingEvents(enabled, accessToken, (event) => {
    const senderPublicID = event.fromUserPublicID;
    if (!senderPublicID) return;
    const recipient = selectedRef.current;
    if (event.detail?.type === "reaction") {
      if (open && recipient) void loadMessages(recipient);
      void loadConversations();
      return;
    }
    if (senderPublicID === user?.publicID) {
      if (open && recipient) void loadMessages(recipient);
      void loadConversations();
      return;
    }
    if (open && recipient?.publicID === senderPublicID) {
      void loadMessages(recipient);
      return;
    }
    setUnreadByUser((current) => ({
      ...current,
      [senderPublicID]: Math.min(99, (current[senderPublicID] || 0) + 1),
    }));
    setTotalUnread((current) => current + 1);

    const previousConversation = conversations.find(
      (item) => item.user.publicID === senderPublicID,
    );
    void loadConversations().then((snapshot) => {
      // The refreshed conversation is now first-page recent state, so its mute
      // preference is authoritative even for the first message after a long
      // inactive period. Suppress notifications if that refresh failed rather
      // than risking a muted conversation leaking a desktop alert.
      if (!snapshot) return;
      const conversation =
        snapshot.results.find((item) => item.user.publicID === senderPublicID) ||
        previousConversation;
      const sender =
        conversation?.user || users.find((item) => item.publicID === senderPublicID);
      if (
        notificationsEnabled &&
        !conversation?.muted &&
        document.visibilityState !== "visible" &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        new Notification(sender ? displayName(sender) : "DEEIX 站内消息", {
          body:
            event.detail?.content_type === "vocechat/file"
              ? "你收到一个文件"
              : event.detail?.content || "你收到了一条新消息",
        });
      }
    });
  });

  const selectUser = (next: InternalMessagingUser) => {
    setSelected(next);
    setMessages([]);
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
    try {
      await updateInternalMessagingPreferences(
        accessToken,
        conversation.user.publicID,
        preferences,
      );
      await loadConversations();
    } catch {
      setError("会话设置保存失败，请重试。");
    }
  };

  const searchMessages = async () => {
    if (!selected || !messageSearchQuery.trim()) return;
    setSearchingMessages(true);
    try {
      const result = await searchInternalMessagingMessages(
        accessToken,
        messageSearchQuery.trim(),
        selected.publicID,
      );
      setMessageSearchResults(mergeMessages(result.results));
    } catch {
      setError("消息搜索失败，请重试。");
    } finally {
      setSearchingMessages(false);
    }
  };

  const close = () => {
    setOpen(false);
    setSelected(null);
    setMessageSearchOpen(false);
    setReplyTo(null);
    setEditing(null);
  };

  const send = async () => {
    if (!selected || !draft.trim() || sending) return;
    const content = draft.trim();
    setSending(true);
    setDraft("");
    try {
      if (editing) {
        const message = await editInternalMessagingMessage(accessToken, editing.id, content);
        setMessages((items) =>
          mergeMessages(items.map((item) => (item.id === message.id ? message : item))),
        );
        setEditing(null);
      } else {
        const message = replyTo
          ? await replyInternalMessagingMessage(accessToken, selected.publicID, replyTo.id, content)
          : await sendInternalMessagingMessage(accessToken, selected.publicID, content);
        setMessages((items) => mergeMessages(items, [message]));
        setReplyTo(null);
      }
      void loadConversations();
    } catch {
      setDraft(content);
      setError(editing ? "消息编辑失败，请重试。" : "消息发送失败，请重试。");
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
    if (!window.confirm("确定撤回这条消息吗？")) return;
    try {
      await deleteInternalMessagingMessage(accessToken, message.id);
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
      setError("消息撤回失败，请重试。");
    }
  };

  const uploadFile = async (file: File) => {
    if (!selected || uploading) return;
    if (file.size > maxFileBytes) {
      setError(`单个文件不能超过 ${formatFileSize(maxFileBytes)}。`);
      return;
    }
    setUploading(true);
    setError("");
    try {
      const message = await sendInternalMessagingFile(accessToken, selected.publicID, file);
      setMessages((items) => mergeMessages(items, [message]));
      void loadConversations();
    } catch {
      setError("文件发送失败，请重试。");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const focusSearchResult = async (result: InternalMessagingMessage) => {
    let merged = messages;
    if (!messages.some((item) => item.id === result.id) && selected) {
      try {
        const page = await listInternalMessagingMessages(accessToken, selected.publicID, result.id + 1);
        merged = mergeMessages(page.results, messages);
        setMessages(merged);
      } catch {
        setError("无法定位这条消息，请稍后重试。");
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
    if (event.button !== 0) return;
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
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
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
          className="fixed z-[70] flex min-h-0 flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl"
          style={{
            left: windowBounds.x,
            top: windowBounds.y,
            width: windowBounds.width,
            height: windowBounds.height,
          }}
        >
          <header
            className="flex h-14 shrink-0 cursor-move touch-none select-none items-center gap-2 border-b px-3"
            onPointerDown={startWindowDrag}
            onPointerMove={moveWindow}
            onPointerUp={stopWindowDrag}
            onPointerCancel={stopWindowDrag}
          >
            {selected ? (
              <Button
                aria-label="Back to users"
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
                {selected ? displayName(selected) : "站内消息"}
              </p>
              <p className="truncate text-[11px] text-muted-foreground">
                {selected ? selected.username : "拖动标题栏移动窗口"}
              </p>
            </div>
            {selected ? (
              <Button
                aria-label="Search messages"
                variant="ghost"
                size="icon-sm"
                onClick={() => setMessageSearchOpen((current) => !current)}
              >
                <Search />
              </Button>
            ) : null}
            <Button
              aria-label={notificationsEnabled ? "Disable notifications" : "Enable notifications"}
              variant="ghost"
              size="icon-sm"
              disabled={!browserNotificationsAllowed}
              onClick={() => void toggleNotifications()}
            >
              {notificationsEnabled ? <Bell /> : <BellOff />}
            </Button>
            <Button aria-label="Close messages" variant="ghost" size="icon-sm" onClick={close}>
              <X />
            </Button>
          </header>

          {selected ? (
            <div className="flex min-h-0 flex-1 flex-col">
              {messageSearchOpen ? (
                <div className="border-b p-2">
                  <div className="flex gap-2">
                    <Input
                      value={messageSearchQuery}
                      onChange={(event) => setMessageSearchQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void searchMessages();
                      }}
                      placeholder="搜索当前会话"
                    />
                    <Button
                      size="sm"
                      disabled={!messageSearchQuery.trim() || searchingMessages}
                      onClick={() => void searchMessages()}
                    >
                      {searchingMessages ? <LoaderCircle className="animate-spin" /> : "搜索"}
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
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
                {hasMoreMessages ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    disabled={loadingOlderMessages}
                    onClick={() => void loadMessages(selected, nextBefore)}
                  >
                    {loadingOlderMessages ? "加载中…" : "加载更早消息"}
                  </Button>
                ) : null}
                {loadingMessages ? (
                  <Loading />
                ) : error ? (
                  <Empty label={error} />
                ) : messages.length === 0 ? (
                  <Empty label="还没有消息，发起第一句吧。" />
                ) : (
                  messages.map((message) => {
                    const mine = message.fromUserPublicID === user.publicID;
                    return (
                      <div
                        key={message.id}
                        id={`internal-message-${message.id}`}
                        className={cn("flex", mine ? "justify-end" : "justify-start")}
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
                              {messages.find((item) => item.id === message.replyToID)?.content ||
                                "回复较早的消息"}
                            </div>
                          ) : null}
                          {message.deleted ? (
                            <p className="italic opacity-70">消息已撤回</p>
                          ) : message.file ? (
                            <MessageFile
                              accessToken={accessToken}
                              message={message}
                              onError={() => setError("文件下载失败，请重试。")}
                            />
                          ) : (
                            <p className="whitespace-pre-wrap break-words">{message.content}</p>
                          )}
                          <p
                            className={cn(
                              "mt-1 text-[10px]",
                              mine ? "text-primary-foreground/70" : "text-muted-foreground",
                            )}
                          >
                            {message.editedAt ? "已编辑 · " : ""}
                            {formatTime(message.createdAt)}
                          </p>
                          {!message.deleted ? (
                            <span
                            className={cn(
                                "absolute -top-3 hidden items-center rounded-full border bg-background text-foreground shadow-sm group-hover/message:flex",
                                mine ? "right-1" : "left-1",
                            )}
                          >
                              {message.content ? (
                                <MessageAction label="复制" onClick={() => void navigator.clipboard.writeText(message.content)}>
                                  <Clipboard className="size-3" />
                                </MessageAction>
                              ) : null}
                              <MessageAction label="回复" onClick={() => { setReplyTo(message); setEditing(null); }}>
                                <CornerUpLeft className="size-3" />
                              </MessageAction>
                              {mine && !message.file ? (
                                <MessageAction label="编辑" onClick={() => chooseEdit(message)}>
                                  <Pencil className="size-3" />
                                </MessageAction>
                              ) : null}
                              {mine ? (
                                <MessageAction label="撤回" onClick={() => void removeMessage(message)}>
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
              <div className="border-t p-3">
                {replyTo || editing ? (
                  <div className="mb-2 flex items-center gap-2 rounded-md bg-muted px-2 py-1 text-xs">
                    {editing ? <Pencil className="size-3" /> : <CornerUpLeft className="size-3" />}
                    <span className="min-w-0 flex-1 truncate">
                      {editing ? "编辑消息" : `回复：${replyTo?.content || replyTo?.file?.name || "文件"}`}
                    </span>
                    <button
                      type="button"
                      aria-label="Cancel message action"
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
                    aria-label="Attach file"
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={uploading || sending || Boolean(editing)}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {uploading ? <LoaderCircle className="animate-spin" /> : <Paperclip />}
                  </Button>
                  <Textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                    placeholder="输入消息…"
                    className="max-h-28 min-h-10 resize-none"
                  />
                  <Button
                    aria-label="Send"
                    size="icon"
                    disabled={!draft.trim() || sending}
                    onClick={() => void send()}
                  >
                    {sending ? <LoaderCircle className="animate-spin" /> : editing ? <Check /> : <Send />}
                  </Button>
                </div>
              </div>
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
                    最近会话
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "rounded-md px-2 py-1 text-xs",
                      directoryView === "users" && "bg-background font-medium shadow-sm",
                    )}
                    onClick={() => setDirectoryView("users")}
                  >
                    全部用户
                  </button>
                </div>
                {directoryView === "users" ? (
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="搜索用户"
                      className="pl-8"
                    />
                  </div>
                ) : null}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {error ? (
                  <Empty label={error} />
                ) : directoryView === "recent" ? (
                  conversations.length === 0 ? (
                    <Empty label="还没有最近会话，可从全部用户发起聊天。" />
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
                          >
                            <Avatar>
                              <AvatarImage src={item.avatarURL || undefined} />
                              <AvatarFallback>{initials(displayName(item))}</AvatarFallback>
                            </Avatar>
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
                                {conversation.lastMessagePreview || "开始聊天"}
                              </span>
                            </span>
                            <span className="flex shrink-0 flex-col items-end gap-1">
                              <span className="text-[10px] text-muted-foreground">
                                {formatTime(conversation.lastMessageAt)}
                              </span>
                              {unread > 0 ? (
                                <span className="flex min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-destructive-foreground">
                                  {unread > 99 ? "99+" : unread}
                                </span>
                              ) : null}
                            </span>
                          </button>
                          <span className="mr-1 hidden shrink-0 group-hover/conversation:flex">
                            <button
                              type="button"
                              aria-label={conversation.pinned ? "Unpin conversation" : "Pin conversation"}
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
                              aria-label={conversation.muted ? "Unmute conversation" : "Mute conversation"}
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
                  <Empty label="没有可聊天的用户。" />
                ) : (
                  <>
                    {users.map((item) => {
                      const unread = unreadByUser[item.publicID] || 0;
                      return (
                        <button
                          type="button"
                          key={item.publicID}
                          className="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-accent"
                          onClick={() => selectUser(item)}
                        >
                          <Avatar>
                            <AvatarImage src={item.avatarURL || undefined} />
                            <AvatarFallback>{initials(displayName(item))}</AvatarFallback>
                          </Avatar>
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
                        {loadingUsers ? "加载中…" : "加载更多用户"}
                      </Button>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          )}

          {RESIZE_HANDLES.map(({ direction, className }) => (
            <button
              aria-label={`Resize chat window ${direction}`}
              type="button"
              tabIndex={-1}
              key={direction}
              data-direction={direction}
              className={cn("absolute z-10 touch-none border-0 bg-transparent p-0", className)}
              onPointerDown={startResize}
              onPointerMove={resizeWindow}
              onPointerUp={stopResize}
              onPointerCancel={stopResize}
            />
          ))}
        </aside>
      ) : null}

      <Button
        aria-label="Open internal messages"
        className={cn(
          "fixed z-[69] size-11 touch-none cursor-grab rounded-full shadow-lg active:cursor-grabbing",
          open && "hidden",
        )}
        style={buttonPoint ? { left: buttonPoint.x, top: buttonPoint.y } : { right: 20, bottom: 20 }}
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
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      <LoaderCircle className="mr-2 size-4 animate-spin" />加载中…
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
}: {
  accessToken: string;
  message: InternalMessagingMessage;
  onError: () => void;
}) {
  const [imageURL, setImageURL] = React.useState("");
  const file = message.file;
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;

  React.useEffect(() => {
    if (!file?.image) return;
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
  }, [accessToken, file?.image, message.id]);

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
    <button type="button" className="block max-w-full text-left" onClick={() => void download()}>
      {file.image && imageURL ? (
        <img
          src={imageURL}
          className="mb-1 max-h-56 max-w-full rounded-lg object-contain"
          alt={file.name}
        />
      ) : (
        <span className="flex items-center gap-2">
          <FileIcon className="size-8 shrink-0" />
          <span className="min-w-0">
            <span className="block truncate font-medium">{file.name}</span>
            <span className="block text-xs opacity-70">{formatFileSize(file.size)}</span>
          </span>
          <Download className="size-4 shrink-0" />
        </span>
      )}
      {file.image && imageURL ? (
        <span className="flex items-center gap-1 text-xs opacity-75">
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          <Download className="size-3" />
        </span>
      ) : null}
    </button>
  );
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "未知大小";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
