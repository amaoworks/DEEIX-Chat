"use client";

import { useTranslations } from "next-intl";
import * as React from "react";

import {
  useInternalMessagingEvents,
} from "@/features/internal-messaging/components/use-internal-messaging-events";
import {
  getInternalMessagingStatus,
  listInternalMessagingConversations,
} from "@/shared/api/internal-messaging";
import type {
  InternalMessagingConversation,
  InternalMessagingStatus,
} from "@/shared/api/internal-messaging-types";
import { useAuthSession } from "@/shared/auth/auth-session-context";


const NOTIFICATION_STORAGE_PREFIX = "deeix.internal-messaging.notifications.v1";
export function useInternalMessagingLauncher() {
  const t = useTranslations("internalMessaging");
  const { accessToken, user } = useAuthSession();
  const [status, setStatus] = React.useState<InternalMessagingStatus>();
  const [activated, setActivated] = React.useState(false);
  const [windowLoadFailed, setWindowLoadFailed] = React.useState(false);
  const [loadAttempt, setLoadAttempt] = React.useState(0);
  const conversationsRef = React.useRef<InternalMessagingConversation[]>([]);
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

  const open = () => setActivated(true);

  const retryWindowLoad = () => {
    setWindowLoadFailed(false);
    setLoadAttempt((current) => current + 1);
  };

  return {
    t,
    user,
    status,
    activated,
    setWindowLoadFailed,
    loadAttempt,
    open,
    retryWindowLoad,
  };
}
