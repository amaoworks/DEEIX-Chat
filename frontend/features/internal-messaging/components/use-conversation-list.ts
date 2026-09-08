"use client";

import * as React from "react";
import { loadConversationPages } from "../model/conversation-pages";
import { listInternalMessagingConversations } from "@/shared/api/internal-messaging";
import type { InternalMessagingConversationPage } from "@/shared/api/internal-messaging.types";

export function useConversationList(accessToken: string, enabled: boolean,
  onSnapshot: (page: InternalMessagingConversationPage) => void,
) {
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [hasMore, setHasMore] = React.useState(false);
  const pages = React.useRef(1);
  const request = React.useRef<AbortController | null>(null);
  const callback = React.useRef(onSnapshot);
  callback.current = onSnapshot;

  const refresh = React.useCallback(async (more = false) => {
    if (!enabled) return;
    if (more && request.current) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setLoading(true);
    setFailed(false);
    const requestedPages = pages.current + (more ? 1 : 0);
    try {
      const { snapshot, loaded } = await loadConversationPages(
        (page, signal) => listInternalMessagingConversations(accessToken, page, signal),
        requestedPages, controller.signal,
      );
      if (snapshot && request.current === controller) {
        pages.current = loaded;
        setHasMore(snapshot.hasMore);
        callback.current(snapshot);
      }
      return snapshot;
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  }, [accessToken, enabled]);

  React.useEffect(() => {
    pages.current = 1;
    return () => { request.current?.abort(); };
  }, [accessToken]);
  return { refresh, loading, failed, hasMore };
}
