"use client";

import * as React from "react";
import { EMPTY_DRAFT, MessageComposer, type OutgoingMessage } from "../model/message-composer";
import {
  editInternalMessagingMessage, replyInternalMessagingMessage,
  sendInternalMessagingFile, sendInternalMessagingMessage,
} from "@/shared/api/internal-messaging";
import type { InternalMessagingMessage } from "@/shared/api/internal-messaging.types";

export function useMessageComposer(
  accountID: string, peerID: string, accessToken: string,
  onDelivered: (peerID: string, message: InternalMessagingMessage) => void,
) {
  const store = React.useMemo(() => new MessageComposer(), [accountID]);
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const draft = snapshot.drafts[peerID] || EMPTY_DRAFT;
  const callback = React.useRef(onDelivered);
  callback.current = onDelivered;
  const activeStore = React.useRef<MessageComposer | null>(store);
  React.useEffect(() => {
    activeStore.current = store;
    return () => { activeStore.current = null; };
  }, [store]);

  const deliver = async (item: OutgoingMessage | undefined) => {
    if (!item) return;
    let message: InternalMessagingMessage;
    try {
      message = item.file
        ? await sendInternalMessagingFile(accessToken, item.peerID, item.file)
        : item.editID
          ? await editInternalMessagingMessage(accessToken, item.editID, item.content)
          : item.replyToID
            ? await replyInternalMessagingMessage(accessToken, item.peerID, item.replyToID, item.content)
            : await sendInternalMessagingMessage(accessToken, item.peerID, item.content);
    } catch {
      store.fail(item.id);
      return;
    }
    store.remove(item.id);
    if (activeStore.current === store) callback.current(item.peerID, message);
  };
  return {
    draft: draft.content, replyTo: draft.replyTo, editing: draft.editing,
    setDraft: (content: string) => store.patch(peerID, { content }),
    setReplyTo: (replyTo: InternalMessagingMessage | null) => store.patch(peerID, { replyTo }),
    setEditing: (editing: InternalMessagingMessage | null) => store.patch(peerID, { editing }),
    outgoing: snapshot.outgoing.filter((item) => item.peerID === peerID),
    send: () => deliver(store.begin(peerID)),
    upload: (file: File) => deliver(store.begin(peerID, file)),
    retry: (id: number) => deliver(store.retry(id)),
    discard: (id: number) => store.remove(id),
  };
}
