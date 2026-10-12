"use client";

import { displayName, formatFileSize } from "../model/message-format";

import { useLocale, useTranslations } from "next-intl";
import * as React from "react";

import type { CachedConversation } from "@/features/internal-messaging/model/conversation-cache";
import {
  createCachedConversation,
  MAX_CONCURRENT_PREFETCHES,
  readConversationCache,
  writeConversationCache,
} from "@/features/internal-messaging/model/conversation-cache";
import {
  applySelectedConversationLiveEvent,
  mergeMessages,
} from "@/features/internal-messaging/model/live-event-merge";
import { loadUserPages } from "@/features/internal-messaging/model/user-pages";
import { useInternalMessagingEvents } from "@/features/internal-messaging/components/use-internal-messaging-events";
import {
  deleteInternalMessagingMessage,
  getInternalMessagingStatus,
  listInternalMessagingMessages,
  listInternalMessagingUsers,
  searchInternalMessagingMessages,
  updateInternalMessagingPreferences,
} from "@/shared/api/internal-messaging";
import type {
  InternalMessagingConversation,
  InternalMessagingMessage,
  InternalMessagingStatus,
  InternalMessagingUser,
} from "@/shared/api/internal-messaging-types";
import { useAuthSession } from "@/shared/auth/auth-session-context";

import { useMessagingWindowLayout, } from "../components/use-messaging-window-layout";
import { useConversationList } from "../components/use-conversation-list";
import { useMessageReadState } from "../components/use-message-read-state";
import { useMessageComposer } from "../components/use-message-composer";
import {
  notificationButtonState,
  type NotificationPermissionState,
} from "../model/message-time";

type PendingMessageScroll =
  | { mode: "bottom"; behavior: ScrollBehavior }
  | { mode: "preserve"; scrollHeight: number; scrollTop: number };
export type MessageFocusRequest = { id: number; sequence: number };
export type MessageScrollAnchor = { id: number; offset: number };
const NOTIFICATION_STORAGE_PREFIX = "deeix.internal-messaging.notifications.v1";
const MESSAGE_BOTTOM_THRESHOLD = 80;

export function useInternalMessagingWindow({
  initiallyOpen = false,
  initialStatus,
}: {
  initiallyOpen?: boolean;
  initialStatus?: InternalMessagingStatus;
}) {
  const t = useTranslations("internalMessaging");
  const locale = useLocale();
  const { accessToken, user } = useAuthSession();
  const [pendingDeleteMessage, setPendingDeleteMessage] = React.useState<InternalMessagingMessage | null>(null);
  const [enabled, setEnabled] = React.useState(initialStatus?.enabled || false);
  const [maxFileBytes, setMaxFileBytes] = React.useState(
    initialStatus?.maxFileBytes || 20 * 1024 * 1024,
  );
  const [browserNotificationsAllowed, setBrowserNotificationsAllowed] = React.useState(
    initialStatus?.browserNotifications ?? true,
  );
  const [open, setOpen] = React.useState(initiallyOpen);
  const { mobileLayout, expanded, setExpanded, windowBounds, startWindowDrag, moveWindow, stopWindowDrag, startResize, resizeWindow, stopResize } = useMessagingWindowLayout(user?.publicID || "");
  const [users, setUsers] = React.useState<InternalMessagingUser[]>([]);
  const [conversations, setConversations] = React.useState<InternalMessagingConversation[]>([]);
  const [directoryView, setDirectoryView] = React.useState<"recent" | "users">("recent");
  const [query, setQuery] = React.useState("");
  const [hasMoreUsers, setHasMoreUsers] = React.useState(false);
  const [selected, setSelected] = React.useState<InternalMessagingUser | null>(null);
  const selectedPublicID = selected?.publicID || "";
  const [messages, setMessages] = React.useState<InternalMessagingMessage[]>([]);
  const [loadingUsers, setLoadingUsers] = React.useState(false);
  const [loadingMessages, setLoadingMessages] = React.useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = React.useState(false);
  const [hasMoreMessages, setHasMoreMessages] = React.useState(false);
  const [nextBefore, setNextBefore] = React.useState(0);
  const [unreadByUser, setUnreadByUser] = React.useState<Record<string, number>>({});
  const [totalUnread, setTotalUnread] = React.useState(initialStatus?.unreadCount || 0);
  const [messageSearchOpen, setMessageSearchOpen] = React.useState(false);
  const [messageSearchQuery, setMessageSearchQuery] = React.useState("");
  const [messageSearchResults, setMessageSearchResults] = React.useState<InternalMessagingMessage[]>([]);
  const [searchingMessages, setSearchingMessages] = React.useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = React.useState(false);
  const [notificationPermission, setNotificationPermission] =
    React.useState<NotificationPermissionState>("default");
  const [revealedTimestampID, setRevealedTimestampID] = React.useState<number | null>(null);
  const [directoryError, setDirectoryError] = React.useState("");
  const [messageError, setMessageError] = React.useState("");
  const [actionError, setActionError] = React.useState("");
  const [newMessagesBelow, setNewMessagesBelow] = React.useState(false);
  const [messageFocusRequest, setMessageFocusRequest] =
    React.useState<MessageFocusRequest | null>(null);
  const [draggingFile, setDraggingFile] = React.useState(false);
  const [previewMessage, setPreviewMessage] =
    React.useState<InternalMessagingMessage | null>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = React.useState(false);
  const [emojiPage, setEmojiPage] = React.useState(0);
  const [connected, setConnected] = React.useState(false);
  const [presenceReady, setPresenceReady] = React.useState(false);
  const [onlineByUser, setOnlineByUser] = React.useState<Record<string, boolean>>({});
  const windowRef = React.useRef<HTMLElement | null>(null);
  const emojiPopoverRef = React.useRef<HTMLDivElement | null>(null);
  const windowOpenRef = React.useRef(open);
  const resumingRef = React.useRef(false);
  const minimizedScrollRef = React.useRef<{ scrollTop: number; nearBottom: boolean } | null>(null);
  const restoringAnchorRef = React.useRef<MessageScrollAnchor | null>(null);
  const selectedRef = React.useRef<InternalMessagingUser | null>(null);
  const directoryPagesRef = React.useRef(1);
  const directoryRequestRef = React.useRef<AbortController | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
  const messageViewportRef = React.useRef<HTMLDivElement | null>(null);
  const messagesRef = React.useRef<InternalMessagingMessage[]>([]);
  const reconnectHistoryRef = React.useRef(false);
  const historyRequiredRef = React.useRef(true);
  const hasConnectedRef = React.useRef(false);
  const nearMessageBottomRef = React.useRef(true);
  const pendingMessageScrollRef = React.useRef<PendingMessageScroll | null>(null);
  const messageRequestRef = React.useRef<{
    sequence: number;
    controller: AbortController | null;
  }>({ sequence: 0, controller: null });
  const conversationRefreshTimerRef = React.useRef<number | null>(null);
  const messageRefreshTimerRef = React.useRef<number | null>(null);
  const messageCacheRef = React.useRef<Map<string, CachedConversation>>(new Map());
  const messagePrefetchRef = React.useRef<Map<string, Promise<void>>>(new Map());
  selectedRef.current = selected;
  messagesRef.current = messages;
  windowOpenRef.current = open;

  const scrollToMessageBottom = React.useCallback((behavior: ScrollBehavior = "smooth") => {
    const viewport = messageViewportRef.current;
    if (!viewport || !windowOpenRef.current) return;
    restoringAnchorRef.current = null;
    // Smooth targets drift while virtual rows are being measured.
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: messagesRef.current.length > 120 ? "auto" : behavior });
    nearMessageBottomRef.current = true;
    setNewMessagesBelow(false);
  }, []);

  const maintainMessageBottom = React.useCallback(() => {
    if (nearMessageBottomRef.current && !reconnectHistoryRef.current) scrollToMessageBottom("auto");
  }, [scrollToMessageBottom]);

  const messageByID = React.useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );

  React.useEffect(() => {
    if (!selectedPublicID) return;
    writeConversationCache(
      messageCacheRef.current,
      selectedPublicID,
      createCachedConversation(messages, hasMoreMessages, nextBefore),
    );
  }, [hasMoreMessages, messages, nextBefore, selectedPublicID]);

  React.useLayoutEffect(() => {
    const viewport = messageViewportRef.current;
    if (!open || !viewport) return;
    const minimized = minimizedScrollRef.current;
    if (minimized) {
      minimizedScrollRef.current = null;
      pendingMessageScrollRef.current = null;
      nearMessageBottomRef.current = minimized.nearBottom;
      if (!restoringAnchorRef.current) viewport.scrollTop = minimized.scrollTop;
      if (minimized.nearBottom && !reconnectHistoryRef.current) scrollToMessageBottom("auto");
      return;
    }
    const pending = pendingMessageScrollRef.current;
    if (!pending) return;
    pendingMessageScrollRef.current = null;
    if (pending.mode === "preserve") {
      viewport.scrollTop =
        pending.scrollTop + (viewport.scrollHeight - pending.scrollHeight);
      return;
    }
    scrollToMessageBottom(pending.behavior);
  }, [messages, open, scrollToMessageBottom]);

  const handleMessageScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!windowOpenRef.current) return;
    const viewport = event.currentTarget;
    const distance = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    const nearBottom = distance <= MESSAGE_BOTTOM_THRESHOLD;
    nearMessageBottomRef.current = nearBottom;
    if (nearBottom && !reconnectHistoryRef.current) {
      setNewMessagesBelow(false);
      acknowledgeVisibleMessages();
    }
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
          // Keep the configured feature and drafts visible during transient outages.
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
    resumingRef.current = false;
    minimizedScrollRef.current = null;
    restoringAnchorRef.current = null;
    historyRequiredRef.current = true;
    setOpen(false);
    setSelected(null);
    setMessages([]);
    setPreviewMessage(null);
  }, [enabled]);

  React.useEffect(() => {
    try {
      setNotificationsEnabled(window.localStorage.getItem(`${NOTIFICATION_STORAGE_PREFIX}:${user?.publicID}`) === "true");
    } catch { setNotificationsEnabled(false); }
  }, [user?.publicID]);

  React.useEffect(() => {
    if (!("Notification" in window)) {
      setNotificationPermission("unsupported");
      return;
    }
    setNotificationPermission(Notification.permission);
    if (!navigator.permissions?.query) return;
    let disposed = false;
    let status: PermissionStatus | undefined;
    const sync = () => {
      if (!disposed && "Notification" in window) {
        setNotificationPermission(Notification.permission);
      }
    };
    void navigator.permissions
      .query({ name: "notifications" })
      .then((result) => {
        if (disposed) return;
        status = result;
        sync();
        result.addEventListener("change", sync);
      })
      .catch(() => {
        // Safari and some embedded browsers reject the notifications permission query.
      });
    return () => {
      disposed = true;
      status?.removeEventListener("change", sync);
    };
  }, []);

  React.useEffect(() => {
    if (!browserNotificationsAllowed) setNotificationsEnabled(false);
  }, [browserNotificationsAllowed]);

  const conversationList = useConversationList(accessToken, enabled, (result) => {
    setConversations(result.results);
    const profiles = new Map(result.results.map((item) => [item.user.publicID, item.user]));
    setUsers((current) => current.map((item) => profiles.get(item.publicID) || item));
    setTotalUnread(result.totalUnread);
    setUnreadByUser(Object.fromEntries(result.results.map((item) => [item.user.publicID, item.unreadCount])));
  });
  const loadConversations = conversationList.refresh;

  const composer = useMessageComposer(user?.publicID || "", selected?.publicID || "", accessToken,
    (peerID, message) => {
      messageCacheRef.current.delete(peerID);
      if (selectedRef.current?.publicID === peerID) {
        if (windowOpenRef.current) {
          pendingMessageScrollRef.current = { mode: "bottom", behavior: "smooth" };
        } else {
          setNewMessagesBelow(true);
        }
        setMessages((items) => mergeMessages(items, [message]));
      }
      void loadConversations();
    });
  const { draft, setDraft, replyTo, setReplyTo, editing, setEditing, send } = composer;
  const sending = composer.outgoing.some((item) => item.status === "sending" && !item.file);
  const uploading = composer.outgoing.some((item) => item.status === "sending" && item.file);

  const scheduleConversationRefresh = React.useCallback(() => {
    if (conversationRefreshTimerRef.current) return;
    conversationRefreshTimerRef.current = window.setTimeout(() => {
      conversationRefreshTimerRef.current = null;
      void loadConversations();
    }, 150);
  }, [loadConversations]);

  const acknowledgeVisibleMessages = useMessageReadState({
    accessToken, open, enabled: enabled && !reconnectHistoryRef.current && !historyRequiredRef.current,
    peerID: selected?.publicID || "",
    throughMID: messages.reduce((maximum, item) => Math.max(maximum, item.id), 0),
    unreadCount: unreadByUser[selected?.publicID || ""] || 0,
    nearBottom: nearMessageBottomRef, onRead: scheduleConversationRefresh,
  });

  const loadUsers = React.useCallback(
    async (reset = false, more = false) => {
      if (!enabled) return;
      if (!reset && directoryRequestRef.current) return;
      const controller = new AbortController();
      directoryRequestRef.current?.abort();
      directoryRequestRef.current = controller;
      if (reset) directoryPagesRef.current = 1;
      setLoadingUsers(true);
      setDirectoryError("");
      try {
        const { snapshot, loaded } = await loadUserPages(
          (page, signal) => listInternalMessagingUsers(accessToken, query, page, signal),
          directoryPagesRef.current + (more ? 1 : 0), controller.signal,
        );
        if (!snapshot || directoryRequestRef.current !== controller) return;
        directoryPagesRef.current = loaded;
        setUsers(snapshot.results);
        setHasMoreUsers(snapshot.hasMore);
      } catch {
        if (!controller.signal.aborted) setDirectoryError(t("errors.directory"));
      } finally {
        if (directoryRequestRef.current === controller) {
          directoryRequestRef.current = null;
          setLoadingUsers(false);
        }
      }
    },
    [accessToken, enabled, query, t],
  );

  const loadMessages = React.useCallback(
    async (recipientPublicID: string, before = 0) => {
      if (!before) historyRequiredRef.current = true;
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
          recipientPublicID,
          before || undefined,
          controller.signal,
        );
        if (
          sequence !== messageRequestRef.current.sequence ||
          selectedRef.current?.publicID !== recipientPublicID
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
        if (!before) {
          reconnectHistoryRef.current = false;
          historyRequiredRef.current = false;
        }
        setMessages(merged);
        setHasMoreMessages(page.hasMore);
        setNextBefore(page.nextBefore);
        writeConversationCache(
          messageCacheRef.current,
          recipientPublicID,
          createCachedConversation(merged, page.hasMore, page.nextBefore),
        );
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
    [accessToken, t],
  );

  const prefetchMessages = React.useCallback(
    (recipient: InternalMessagingUser) => {
      const cached = readConversationCache(messageCacheRef.current, recipient.publicID);
      if (cached) return;
      if (messagePrefetchRef.current.has(recipient.publicID)) return;
      if (messagePrefetchRef.current.size >= MAX_CONCURRENT_PREFETCHES) return;
      const request = listInternalMessagingMessages(accessToken, recipient.publicID)
        .then((page) => {
          writeConversationCache(
            messageCacheRef.current,
            recipient.publicID,
            createCachedConversation(
              mergeMessages(page.results),
              page.hasMore,
              page.nextBefore,
            ),
          );
        })
        .catch(() => undefined)
        .finally(() => messagePrefetchRef.current.delete(recipient.publicID));
      messagePrefetchRef.current.set(recipient.publicID, request);
    },
    [accessToken],
  );

  React.useEffect(() => {
    if (!enabled) return;
    const refresh = () => { if (document.visibilityState === "visible") void loadConversations(); };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [enabled, loadConversations]);
  React.useEffect(() => {
    if (!open || directoryView !== "users") return;
    void loadUsers(true);
    const refresh = () => { if (document.visibilityState === "visible") void loadUsers(); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      directoryRequestRef.current?.abort();
      directoryRequestRef.current = null;
    };
  }, [directoryView, loadUsers, open]);
  React.useEffect(() => {
    if (!enabled || !open || !selectedPublicID) return;
    let request: AbortController | null = null;
    let disposed = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible" || request) return;
      const controller = new AbortController();
      request = controller;
      try {
        // Search by stable ID: the peer may be outside loaded pages or no longer match the directory query.
        const result = await listInternalMessagingUsers(accessToken, selectedPublicID, 1, controller.signal);
        if (disposed || controller.signal.aborted) return;
        const profile = result.results.find((item) => item.publicID === selectedPublicID);
        if (profile) {
          setSelected((current) => current?.publicID === profile.publicID ? profile : current);
        }
      } catch {
        // Retain the last known profile during transient failures.
      } finally {
        if (request === controller) request = null;
      }
    };
    void refresh();
    const onFocus = () => { void refresh(); };
    const timer = window.setInterval(onFocus, 30_000);
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      request?.abort();
    };
  }, [accessToken, enabled, open, selectedPublicID]);
  React.useEffect(() => {
    // Profile refreshes must not replace loaded history or move the scroll position.
    if (!open || !selectedPublicID) return;
    if (resumingRef.current) {
      resumingRef.current = false;
      // Live events keep this mounted conversation current while minimized.
      // If the stream had a gap, keep the reading position and offer a history refresh.
      // A canceled initial load still needs history, even if a live message arrived meanwhile.
      if (!historyRequiredRef.current) return;
    }
    void loadMessages(selectedPublicID);
  }, [loadMessages, open, selectedPublicID]);
  React.useEffect(
    () => () => {
      messageRequestRef.current.controller?.abort();
      if (conversationRefreshTimerRef.current) {
        window.clearTimeout(conversationRefreshTimerRef.current);
      }
      if (messageRefreshTimerRef.current) window.clearTimeout(messageRefreshTimerRef.current);
    },
    [],
  );

  useInternalMessagingEvents(enabled, accessToken, (event) => {
    if (
      event.type !== "chat" &&
      event.type !== "users_state" &&
      event.type !== "users_state_changed"
    ) {
      return;
    }
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
      recipient && peerPublicID && recipient.publicID === peerPublicID,
    );

    if (canonical && peerPublicID) {
      if (selectedConversation) {
        const decision = applySelectedConversationLiveEvent({
          loaded: messagesRef.current,
          incoming: canonical,
          reaction,
        });
        if (decision.mergedAsTail) {
          if (open && nearMessageBottomRef.current && !reconnectHistoryRef.current) {
            pendingMessageScrollRef.current = { mode: "bottom", behavior: "auto" };
          } else if (incoming) {
            setNewMessagesBelow(true);
          }
        }
        if (decision.changed) {
          setMessages((current) =>
            applySelectedConversationLiveEvent({
              loaded: current,
              incoming: canonical,
              reaction,
            }).messages,
          );
        }
      }
      if ((!open || !selectedConversation) && incoming && !reaction) {
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
      // Retain the gap even if minimization cancels the delayed fallback refresh.
      if (recipient) {
        reconnectHistoryRef.current = true;
        setNewMessagesBelow(true);
      }
      if (open && recipient && !messageRefreshTimerRef.current) {
        messageRefreshTimerRef.current = window.setTimeout(() => {
          messageRefreshTimerRef.current = null;
          const currentRecipient = selectedRef.current;
          if (windowOpenRef.current && currentRecipient) void loadMessages(currentRecipient.publicID);
        }, 150);
      }
      scheduleConversationRefresh();
      return;
    }

    const readingConversation = open && selectedConversation && document.visibilityState === "visible" && document.hasFocus() && nearMessageBottomRef.current;
    if (!incoming || reaction || readingConversation) return;

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
    setConnected(connected);
    if (!connected) {
      setPresenceReady(false);
      return;
    }
    if (hasConnectedRef.current) {
      scheduleConversationRefresh();
      const recipient = selectedRef.current;
      if (recipient) {
        reconnectHistoryRef.current = true;
        if (open && nearMessageBottomRef.current && document.visibilityState === "visible") {
          void loadMessages(recipient.publicID);
        } else {
          setNewMessagesBelow(true);
        }
      }
    }
    hasConnectedRef.current = true;
  });

  const selectUser = (next: InternalMessagingUser) => {
    resumingRef.current = false;
    minimizedScrollRef.current = null;
    restoringAnchorRef.current = null;
    reconnectHistoryRef.current = false;
    historyRequiredRef.current = true;
    messageRequestRef.current.controller?.abort();
    messageRequestRef.current = {
      sequence: messageRequestRef.current.sequence + 1,
      controller: null,
    };
    const cached = readConversationCache(messageCacheRef.current, next.publicID);
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
    setMessageFocusRequest(null);
    setRevealedTimestampID(null);
  };

  const notificationState = notificationButtonState({
    adminAllowed: browserNotificationsAllowed,
    permission: notificationPermission,
    enabled: notificationsEnabled,
  });

  const toggleNotifications = async () => {
    if (!user?.publicID || !browserNotificationsAllowed || !("Notification" in window)) return;
    if (Notification.permission === "denied") return;
    const currentlyActive =
      notificationsEnabled && Notification.permission === "granted";
    let next = !currentlyActive;
    if (next && Notification.permission !== "granted") {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      next = permission === "granted";
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

  const minimize = React.useCallback(() => {
    if (!windowOpenRef.current) return;
    const viewport = messageViewportRef.current;
    minimizedScrollRef.current = viewport ? {
      scrollTop: viewport.scrollTop,
      nearBottom: nearMessageBottomRef.current,
    } : null;
    restoringAnchorRef.current = null;
    if (viewport && !nearMessageBottomRef.current) {
      const top = viewport.getBoundingClientRect().top;
      const row = Array.from(viewport.querySelectorAll<HTMLElement>("[data-message-id]"))
        .find((element) => element.getBoundingClientRect().bottom > top);
      if (row) {
        restoringAnchorRef.current = {
          id: Number(row.dataset.messageId),
          offset: row.getBoundingClientRect().top - top,
        };
      }
    }
    resumingRef.current = true;
    windowOpenRef.current = false;
    messageRequestRef.current.controller?.abort();
    messageRequestRef.current = {
      sequence: messageRequestRef.current.sequence + 1,
      controller: null,
    };
    if (messageRefreshTimerRef.current) {
      window.clearTimeout(messageRefreshTimerRef.current);
      messageRefreshTimerRef.current = null;
    }
    setOpen(false);
    setLoadingMessages(false);
    setLoadingOlderMessages(false);
    setEmojiPickerOpen(false);
    setPreviewMessage(null);
    setDraggingFile(false);
    pendingMessageScrollRef.current = null;
  }, []);

  React.useEffect(() => {
    if (!open || mobileLayout || previewMessage) return;
    let startedOutside = false;
    const onPointerDown = (event: PointerEvent) => {
      startedOutside = false;
      if (event.button !== 0 || !event.isPrimary) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (windowRef.current?.contains(target) || emojiPopoverRef.current?.contains(target)) return;
      startedOutside = true;
    };
    const onClick = () => {
      // Wait for a complete outside click so the newly mounted launcher cannot intercept pointerup.
      // An inside-origin drag/resize never qualifies; do not cancel the underlying page action.
      if (startedOutside) minimize();
      startedOutside = false;
    };
    const onPointerCancel = () => { startedOutside = false; };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("pointercancel", onPointerCancel, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("pointercancel", onPointerCancel, true);
    };
  }, [minimize, mobileLayout, open, previewMessage]);

  const chooseEdit = (message: InternalMessagingMessage) => {
    setEditing(message);
    setReplyTo(null);
    setDraft(message.content);
  };

  const removeMessage = async (message: InternalMessagingMessage) => {
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
    if (file.size > maxFileBytes) {
      setActionError(
        t("file.tooLarge", {
          size: formatFileSize(maxFileBytes, locale, t("file.unknownSize")),
        }),
      );
      return;
    }
    await composer.upload(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
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
    nearMessageBottomRef.current = false;
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
        setMessages((current) => mergeMessages(page.results, current));
      } catch {
        if (selectedRef.current?.publicID === recipientPublicID) {
          setActionError(t("errors.locate"));
        }
        return;
      }
    }
    setMessageSearchOpen(false);
    setMessageFocusRequest((current) => ({ id: result.id, sequence: (current?.sequence || 0) + 1 }));
  };

  return {
    t,
    locale,
    accessToken,
    user,
    pendingDeleteMessage,
    setPendingDeleteMessage,
    enabled,
    open,
    setOpen,
    mobileLayout,
    expanded,
    setExpanded,
    windowBounds,
    startWindowDrag,
    moveWindow,
    stopWindowDrag,
    startResize,
    resizeWindow,
    stopResize,
    users,
    conversations,
    directoryView,
    setDirectoryView,
    query,
    setQuery,
    hasMoreUsers,
    selected,
    setSelected,
    messages,
    loadingUsers,
    loadingMessages,
    loadingOlderMessages,
    hasMoreMessages,
    nextBefore,
    unreadByUser,
    totalUnread,
    messageSearchOpen,
    setMessageSearchOpen,
    messageSearchQuery,
    setMessageSearchQuery,
    messageSearchResults,
    searchingMessages,
    revealedTimestampID,
    setRevealedTimestampID,
    directoryError,
    messageError,
    actionError,
    setActionError,
    newMessagesBelow,
    messageFocusRequest,
    draggingFile,
    setDraggingFile,
    previewMessage,
    setPreviewMessage,
    emojiPickerOpen,
    setEmojiPickerOpen,
    emojiPage,
    setEmojiPage,
    connected,
    presenceReady,
    onlineByUser,
    windowRef,
    emojiPopoverRef,
    windowOpenRef,
    restoringAnchorRef,
    fileInputRef,
    composerRef,
    messageViewportRef,
    reconnectHistoryRef,
    historyRequiredRef,
    nearMessageBottomRef,
    pendingMessageScrollRef,
    scrollToMessageBottom,
    maintainMessageBottom,
    messageByID,
    handleMessageScroll,
    conversationList,
    loadConversations,
    composer,
    draft,
    setDraft,
    replyTo,
    setReplyTo,
    editing,
    setEditing,
    send,
    sending,
    uploading,
    acknowledgeVisibleMessages,
    loadUsers,
    loadMessages,
    prefetchMessages,
    selectUser,
    notificationState,
    toggleNotifications,
    updateConversationPreference,
    searchMessages,
    minimize,
    chooseEdit,
    removeMessage,
    uploadFile,
    pasteFile,
    dropFile,
    insertEmoji,
    focusSearchResult,
  };
}
