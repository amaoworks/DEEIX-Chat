"use client";

import * as React from "react";

import { startMessagingEventStream } from "@/features/internal-messaging/model/messaging-event-stream";
import { openInternalMessagingEvents } from "@/shared/api/internal-messaging";
import type { InternalMessagingMessage } from "@/shared/api/internal-messaging.types";

export type InternalMessagingEvent = {
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

export function useInternalMessagingEvents(
  enabled: boolean,
  accessToken: string,
  onEvent: (event: InternalMessagingEvent) => void,
  onConnectionChange?: (connected: boolean) => void,
) {
  const eventCallback = React.useRef(onEvent);
  const connectionCallback = React.useRef(onConnectionChange);
  eventCallback.current = onEvent;
  connectionCallback.current = onConnectionChange;

  React.useEffect(() => {
    if (!enabled || !accessToken) return;
    return startMessagingEventStream<InternalMessagingEvent>({
      openStream: (afterMID, signal) =>
        openInternalMessagingEvents(accessToken, afterMID, signal),
      onEvent: (event) => eventCallback.current(event),
      onConnectionChange: (connected) =>
        connectionCallback.current?.(connected),
    });
  }, [accessToken, enabled]);
}
