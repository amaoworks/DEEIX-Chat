"use client";

import * as React from "react";
import { markInternalMessagingRead } from "@/shared/api/internal-messaging";
import { canReadConversation } from "../model/message-read-state";

export function useMessageReadState(options: {
  accessToken: string; open: boolean; enabled: boolean; peerID: string;
  throughMID: number; unreadCount: number; nearBottom: React.RefObject<boolean>;
  onRead: () => void;
}) {
  const latest = React.useRef(options);
  latest.current = options;
  const acknowledge = React.useRef<(reconcile?: boolean) => void>(() => {});

  React.useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let failures = 0;
    const committed = new Map<string, number>();
    const flush = async () => {
      timer = undefined;
      const current = latest.current;
      if (disposed || inFlight || current.throughMID <= (committed.get(current.peerID) || 0) ||
          !canReadConversation({ ...current, selectedPeerID: current.peerID,
            visible: document.visibilityState === "visible", focused: document.hasFocus(),
            nearBottom: current.nearBottom.current })) return;
      inFlight = true;
      try {
        await markInternalMessagingRead(current.accessToken, current.peerID, current.throughMID);
        if (disposed) return;
        committed.set(current.peerID, current.throughMID);
        failures = 0;
        latest.current.onRead();
      } catch {
        failures++;
      } finally {
        inFlight = false;
        if (!disposed) timer = setTimeout(flush, failures ? Math.min(30_000, 500 * 2 ** Math.min(failures, 6)) : 150);
      }
    };
    const schedule = (reconcile = false) => {
      if (reconcile) committed.delete(latest.current.peerID);
      if (!disposed && !timer && !inFlight) timer = setTimeout(flush, 150);
    };
    acknowledge.current = schedule;
    const onVisible = () => schedule();
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    schedule();
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [options.accessToken]);

  // A repaired index can reveal unread messages at a cursor we already tried
  // to acknowledge while the local index was incomplete.
  React.useEffect(() => {
    if (options.unreadCount > 0) acknowledge.current(true);
  }, [options.peerID, options.unreadCount]);
  React.useEffect(() => { acknowledge.current(); }, [options.peerID, options.throughMID, options.open, options.enabled]);
  return React.useCallback(() => acknowledge.current(), []);
}
