"use client";

import * as React from "react";
import {
  ChevronLeft,
  LoaderCircle,
  MessageCircle,
  MoveDiagonal2,
  Search,
  Send,
  X,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  getInternalMessagingStatus,
  listInternalMessagingMessages,
  listInternalMessagingUsers,
  openInternalMessagingEvents,
  sendInternalMessagingMessage,
} from "@/shared/api/internal-messaging";
import type {
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
};

const VIEWPORT_MARGIN = 8;
const BUTTON_SIZE = 44;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 360;

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
  const [open, setOpen] = React.useState(false);
  const [users, setUsers] = React.useState<InternalMessagingUser[]>([]);
  const [query, setQuery] = React.useState("");
  const [directoryPage, setDirectoryPage] = React.useState(1);
  const [hasMoreUsers, setHasMoreUsers] = React.useState(false);
  const [selected, setSelected] = React.useState<InternalMessagingUser | null>(null);
  const [messages, setMessages] = React.useState<InternalMessagingMessage[]>([]);
  const [draft, setDraft] = React.useState("");
  const [loadingUsers, setLoadingUsers] = React.useState(false);
  const [loadingMessages, setLoadingMessages] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [unreadByUser, setUnreadByUser] = React.useState<Record<string, number>>({});
  const [error, setError] = React.useState("");
  const [buttonPoint, setButtonPoint] = React.useState<Point | null>(null);
  const [windowBounds, setWindowBounds] = React.useState<WindowBounds>(initialWindowBounds);
  const selectedRef = React.useRef<InternalMessagingUser | null>(null);
  const buttonDragRef = React.useRef<DragSnapshot | null>(null);
  const windowDragRef = React.useRef<DragSnapshot | null>(null);
  const resizeRef = React.useRef<ResizeSnapshot | null>(null);
  const suppressButtonClickRef = React.useRef(false);
  selectedRef.current = selected;

  const totalUnread = React.useMemo(
    () => Object.values(unreadByUser).reduce((total, count) => total + count, 0),
    [unreadByUser],
  );

  React.useEffect(() => {
    let disposed = false;
    void getInternalMessagingStatus(accessToken)
      .then((status) => {
        if (!disposed) setEnabled(status.enabled);
      })
      .catch(() => {
        if (!disposed) setEnabled(false);
      });
    return () => {
      disposed = true;
    };
  }, [accessToken]);

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
    async (recipient: InternalMessagingUser) => {
      setLoadingMessages(true);
      setError("");
      try {
        const next = await listInternalMessagingMessages(accessToken, recipient.publicID);
        setMessages([...next].sort((left, right) => left.id - right.id));
      } catch {
        setError("消息暂时无法加载。");
      } finally {
        setLoadingMessages(false);
      }
    },
    [accessToken],
  );

  React.useEffect(() => {
    if (open) void loadUsers(1, false);
  }, [loadUsers, open]);
  React.useEffect(() => {
    if (open && selected) void loadMessages(selected);
  }, [loadMessages, open, selected]);

  useMessagingEvents(enabled, accessToken, (event) => {
    const senderPublicID = event.fromUserPublicID;
    if (!senderPublicID || senderPublicID === user?.publicID) return;
    const recipient = selectedRef.current;
    if (open && recipient?.publicID === senderPublicID) {
      void loadMessages(recipient);
      return;
    }
    setUnreadByUser((current) => ({
      ...current,
      [senderPublicID]: Math.min(99, (current[senderPublicID] || 0) + 1),
    }));
  });

  const selectUser = (next: InternalMessagingUser) => {
    setSelected(next);
    setMessages([]);
    setUnreadByUser((current) => {
      if (!current[next.publicID]) return current;
      const updated = { ...current };
      delete updated[next.publicID];
      return updated;
    });
  };

  const close = () => {
    setOpen(false);
    setSelected(null);
  };

  const send = async () => {
    if (!selected || !draft.trim() || sending) return;
    const content = draft.trim();
    setSending(true);
    setDraft("");
    try {
      const message = await sendInternalMessagingMessage(accessToken, selected.publicID, content);
      setMessages((items) => [...items, message]);
    } catch {
      setDraft(content);
      setError("消息发送失败，请重试。");
    } finally {
      setSending(false);
    }
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
            <Button aria-label="Close messages" variant="ghost" size="icon-sm" onClick={close}>
              <X />
            </Button>
          </header>

          {selected ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
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
                        className={cn("flex", mine ? "justify-end" : "justify-start")}
                      >
                        <div
                          className={cn(
                            "max-w-[85%] rounded-2xl px-3 py-2 text-sm",
                            mine ? "bg-primary text-primary-foreground" : "bg-muted",
                          )}
                        >
                          <p className="whitespace-pre-wrap break-words">{message.content}</p>
                          <p
                            className={cn(
                              "mt-1 text-[10px]",
                              mine ? "text-primary-foreground/70" : "text-muted-foreground",
                            )}
                          >
                            {formatTime(message.createdAt)}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
              <div className="border-t p-3">
                <div className="flex items-end gap-2">
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
                    {sending ? <LoaderCircle className="animate-spin" /> : <Send />}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="border-b p-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索用户"
                    className="pl-8"
                  />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {loadingUsers && users.length === 0 ? (
                  <Loading />
                ) : error ? (
                  <Empty label={error} />
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
            >
              {direction === "se" ? (
                <MoveDiagonal2 className="pointer-events-none absolute bottom-1 right-1 size-3 text-muted-foreground/70" />
              ) : null}
            </button>
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
