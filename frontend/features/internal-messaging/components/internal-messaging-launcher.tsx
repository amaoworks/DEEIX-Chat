"use client";

import { MessageCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  getInternalMessagingStatus,
  listInternalMessagingConversations,
  openInternalMessagingEvents,
} from "@/shared/api/internal-messaging";
import type {
  InternalMessagingConversation,
  InternalMessagingStatus,
} from "@/shared/api/internal-messaging.types";
import { useAuthSession } from "@/shared/auth/auth-session-context";

type Point = { x: number; y: number };
type DragSnapshot = {
  pointerID: number;
  startX: number;
  startY: number;
  origin: Point;
  moved: boolean;
};
type LauncherEvent = {
  type?: string;
  mid?: number;
  fromUserPublicID?: string;
  conversationPublicID?: string;
  detail?: { type?: string; content?: string; content_type?: string };
};

const LazyInternalMessagingWindow = React.lazy(async () => {
  const module = await import("./internal-messaging-host");
  return { default: module.InternalMessagingWindowHost };
});

const VIEWPORT_MARGIN = 8;
const BUTTON_SIZE = 44;
const LAYOUT_STORAGE_PREFIX = "deeix.internal-messaging.layout.v1";
const NOTIFICATION_STORAGE_PREFIX = "deeix.internal-messaging.notifications.v1";

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
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

function useLauncherEvents(
  enabled: boolean,
  accessToken: string,
  onEvent: (event: LauncherEvent) => void,
) {
  const callback = React.useRef(onEvent);
  callback.current = onEvent;

  React.useEffect(() => {
    if (!enabled || !accessToken) return;
    let cancelled = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let latestMID = 0;

    const connect = async () => {
      controller = new AbortController();
      try {
        const response = await openInternalMessagingEvents(
          accessToken,
          latestMID || undefined,
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
              const payload = JSON.parse(data) as LauncherEvent;
              if (typeof payload.mid === "number") latestMID = Math.max(latestMID, payload.mid);
              if (payload.type === "chat") callback.current(payload);
            } catch {
              // Heartbeats and non-JSON events still keep the stream alive.
            }
          }
        }
      } catch {
        // Reconnect below when the optional messaging service becomes available.
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
  const t = useTranslations("internalMessaging");
  const mobileLayout = useMobileMessagingLayout();
  const { accessToken, user } = useAuthSession();
  const [status, setStatus] = React.useState<InternalMessagingStatus>();
  const [activated, setActivated] = React.useState(false);
  const [buttonPoint, setButtonPoint] = React.useState<Point | null>(null);
  const conversationsRef = React.useRef<InternalMessagingConversation[]>([]);
  const dragRef = React.useRef<DragSnapshot | null>(null);
  const suppressClickRef = React.useRef(false);
  const layoutHydratedRef = React.useRef(false);
  const refreshTimerRef = React.useRef<number | null>(null);

  const refreshStatus = React.useCallback(async () => {
    if (!accessToken) return;
    try {
      setStatus(await getInternalMessagingStatus(accessToken));
    } catch {
      setStatus((current) => current && { ...current, enabled: false });
    }
  }, [accessToken]);

  const refreshConversations = React.useCallback(async () => {
    if (!accessToken) return;
    try {
      conversationsRef.current = (
        await listInternalMessagingConversations(accessToken)
      ).results;
    } catch {
      // Keep the last preference snapshot while the optional service reconnects.
    }
  }, [accessToken]);

  React.useEffect(() => {
    if (activated || !accessToken) return;
    void refreshStatus();
    const refresh = () => void refreshStatus();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [accessToken, activated, refreshStatus]);

  React.useEffect(() => {
    if (activated || !status?.enabled) return;
    void refreshConversations();
  }, [activated, refreshConversations, status?.enabled]);

  React.useEffect(() => {
    if (!user?.publicID) return;
    layoutHydratedRef.current = false;
    try {
      const raw = window.localStorage.getItem(`${LAYOUT_STORAGE_PREFIX}:${user.publicID}`);
      const stored = raw ? (JSON.parse(raw) as { button?: unknown }) : undefined;
      if (isPoint(stored?.button)) setButtonPoint(clampButtonPoint(stored.button));
    } catch {
      // Invalid local layout state falls back to the viewport corner.
    }
    setButtonPoint((current) =>
      current
        ? clampButtonPoint(current)
        : { x: window.innerWidth - BUTTON_SIZE - 20, y: window.innerHeight - BUTTON_SIZE - 20 },
    );
    layoutHydratedRef.current = true;
  }, [user?.publicID]);

  React.useEffect(() => {
    const resize = () => setButtonPoint((current) => (current ? clampButtonPoint(current) : null));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  React.useEffect(() => {
    if (!user?.publicID || !layoutHydratedRef.current || !buttonPoint) return;
    const timer = window.setTimeout(() => {
      try {
        const key = `${LAYOUT_STORAGE_PREFIX}:${user.publicID}`;
        const raw = window.localStorage.getItem(key);
        const stored = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        window.localStorage.setItem(key, JSON.stringify({ ...stored, button: buttonPoint }));
      } catch {
        // Storage can be unavailable in privacy-restricted browser contexts.
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [buttonPoint, user?.publicID]);

  useLauncherEvents(Boolean(!activated && status?.enabled), accessToken, (event) => {
    const incoming = Boolean(
      event.fromUserPublicID && event.fromUserPublicID !== user?.publicID,
    );
    const reaction = event.detail?.type === "reaction";
    if (incoming && !reaction) {
      setStatus((current) =>
        current ? { ...current, unreadCount: current.unreadCount + 1 } : current,
      );
      const conversation = conversationsRef.current.find(
        (item) => item.user.publicID === event.conversationPublicID,
      );
      const notificationsEnabled = Boolean(
        user?.publicID &&
          window.localStorage.getItem(
            `${NOTIFICATION_STORAGE_PREFIX}:${user.publicID}`,
          ) === "true",
      );
      if (
        status?.browserNotifications &&
        notificationsEnabled &&
        conversation &&
        !conversation.muted &&
        document.visibilityState !== "visible" &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        new Notification(conversation.user.displayName || conversation.user.username || t("title"), {
          body:
            event.detail?.content_type === "vocechat/file"
              ? t("notifications.file")
              : event.detail?.content || t("notifications.message"),
        });
      }
    }
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshStatus();
      void refreshConversations();
    }, 150);
  });

  React.useEffect(
    () => () => {
      if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
    },
    [],
  );

  const startDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (mobileLayout || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      pointerID: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { x: rect.left, y: rect.top },
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const move = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerID !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 3) drag.moved = true;
    setButtonPoint(clampButtonPoint({ x: drag.origin.x + deltaX, y: drag.origin.y + deltaY }));
  };

  const stopDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerID !== event.pointerId) return;
    suppressClickRef.current = drag.moved;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const open = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setActivated(true);
  };

  if (activated && status) {
    return (
      <React.Suspense
        fallback={
          <LauncherButton
            mobileLayout={mobileLayout}
            buttonPoint={buttonPoint}
            unreadCount={status.unreadCount}
            label={t("aria.open")}
          />
        }
      >
        <LazyInternalMessagingWindow initiallyOpen initialStatus={status} />
      </React.Suspense>
    );
  }
  if (!status?.enabled || !user) return null;

  return (
    <LauncherButton
      mobileLayout={mobileLayout}
      buttonPoint={buttonPoint}
      unreadCount={status.unreadCount}
      label={t("aria.open")}
      onPointerDown={startDrag}
      onPointerMove={move}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      onClick={open}
    />
  );
}

function LauncherButton({
  mobileLayout = false,
  buttonPoint = null,
  unreadCount = 0,
  label = "",
  ...events
}: {
  mobileLayout?: boolean;
  buttonPoint?: Point | null;
  unreadCount?: number;
  label?: string;
} & Pick<
  React.ComponentProps<typeof Button>,
  | "onPointerDown"
  | "onPointerMove"
  | "onPointerUp"
  | "onPointerCancel"
  | "onClick"
>) {
  return (
    <Button
      aria-label={label}
      className={cn(
        "fixed z-[69] size-11 rounded-full shadow-lg",
        mobileLayout
          ? "touch-manipulation cursor-pointer"
          : "touch-none cursor-grab active:cursor-grabbing",
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
      {...events}
    >
      <MessageCircle className="size-5" />
      {unreadCount > 0 ? (
        <span className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] text-destructive-foreground">
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      ) : null}
    </Button>
  );
}
