"use client";

import { MessageCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  useInternalMessagingEvents,
} from "@/features/internal-messaging/components/use-internal-messaging-events";
import { cn } from "@/lib/utils";
import {
  getInternalMessagingStatus,
  listInternalMessagingConversations,
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
function createLazyInternalMessagingWindow() {
  return React.lazy(async () => {
    const module = await import("./internal-messaging-host");
    return { default: module.InternalMessagingWindowHost };
  });
}

class MessagingWindowBoundary extends React.Component<
  {
    children: React.ReactNode;
    fallback: React.ReactNode;
    onError?: () => void;
  },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError?.();
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

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

export function InternalMessagingHost() {
  const t = useTranslations("internalMessaging");
  const mobileLayout = useMobileMessagingLayout();
  const { accessToken, user } = useAuthSession();
  const [status, setStatus] = React.useState<InternalMessagingStatus>();
  const [activated, setActivated] = React.useState(false);
  const [windowLoadFailed, setWindowLoadFailed] = React.useState(false);
  const [loadAttempt, setLoadAttempt] = React.useState(0);
  const LazyInternalMessagingWindow = React.useMemo(
    createLazyInternalMessagingWindow,
    [loadAttempt],
  );
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
      // Keep the last configuration while the connection indicator retries.
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

  useInternalMessagingEvents(
    Boolean((!activated || windowLoadFailed) && status?.enabled),
    accessToken,
    (event) => {
      if (event.type !== "chat") return;
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
          new Notification(
            conversation.user.displayName || conversation.user.username || t("title"),
            {
              body:
                event.detail?.content_type === "vocechat/file"
                  ? t("notifications.file")
                  : event.detail?.content || t("notifications.message"),
            },
          );
        }
      }
      if (refreshTimerRef.current) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void refreshStatus();
        void refreshConversations();
      }, 150);
    },
  );

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

  const retryWindowLoad = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setWindowLoadFailed(false);
    setLoadAttempt((current) => current + 1);
  };

  const launcherEvents = {
    onPointerDown: startDrag,
    onPointerMove: move,
    onPointerUp: stopDrag,
    onPointerCancel: stopDrag,
  };

  if (activated && status) {
    return (
      <MessagingWindowBoundary
        key={`${user?.publicID || "signed-out"}:${loadAttempt}`}
        onError={() => setWindowLoadFailed(true)}
        fallback={
          <LauncherLoadFailure
            mobileLayout={mobileLayout}
            buttonPoint={buttonPoint}
            unreadCount={status.unreadCount}
            label={t("aria.open")}
            errorMessage={t("errors.windowLoad")}
            retryLabel={t("actions.retryLoad")}
            {...launcherEvents}
            onClick={retryWindowLoad}
          />
        }
      >
        <React.Suspense
          fallback={
            <LauncherButton
              mobileLayout={mobileLayout}
              buttonPoint={buttonPoint}
              unreadCount={status.unreadCount}
              label={t("aria.open")}
              {...launcherEvents}
              onClick={open}
            />
          }
        >
          <LazyInternalMessagingWindow initiallyOpen initialStatus={status} />
        </React.Suspense>
      </MessagingWindowBoundary>
    );
  }
  if (!status?.enabled || !user) return null;

  return (
    <LauncherButton
      mobileLayout={mobileLayout}
      buttonPoint={buttonPoint}
      unreadCount={status.unreadCount}
      label={t("aria.open")}
      {...launcherEvents}
      onClick={open}
    />
  );
}

function LauncherLoadFailure({
  errorMessage,
  retryLabel,
  ...buttonProps
}: React.ComponentProps<typeof LauncherButton> & {
  errorMessage: string;
  retryLabel: string;
}) {
  return (
    <>
      <div
        className="fixed bottom-20 right-5 z-[70] max-w-64 rounded-md border bg-background p-3 text-sm shadow-lg"
        role="alert"
      >
        <p>{errorMessage}</p>
        <p className="mt-1 text-xs text-muted-foreground">{retryLabel}</p>
      </div>
      <LauncherButton {...buttonProps} label={retryLabel} />
    </>
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
