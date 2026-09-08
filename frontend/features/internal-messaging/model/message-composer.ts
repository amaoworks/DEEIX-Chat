import type { InternalMessagingMessage } from "../../../shared/api/internal-messaging.types";

export type ConversationDraft = {
  content: string;
  replyTo: InternalMessagingMessage | null;
  editing: InternalMessagingMessage | null;
};
export type OutgoingMessage = {
  id: number;
  peerID: string;
  content: string;
  replyToID?: number;
  editID?: number;
  file?: File;
  status: "sending" | "failed";
};
type Snapshot = {
  drafts: Record<string, ConversationDraft>;
  outgoing: OutgoingMessage[];
};
export const EMPTY_DRAFT: ConversationDraft = { content: "", replyTo: null, editing: null };

export function shouldSendOnEnter(event: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode?: number;
}) {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

// One store per signed-in account. Drafts and failed deliveries stay with their
// recipient even while another conversation is selected or the window is closed.
export class MessageComposer {
  private snapshot: Snapshot = { drafts: {}, outgoing: [] };
  private listeners = new Set<() => void>();
  private sequence = 0;
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(snapshot: Snapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  patch(peerID: string, patch: Partial<ConversationDraft>) {
    if (!peerID) return;
    this.publish({ ...this.snapshot, drafts: {
      ...this.snapshot.drafts,
      [peerID]: { ...(this.snapshot.drafts[peerID] || EMPTY_DRAFT), ...patch },
    } });
  }
  begin(peerID: string, file?: File) {
    const draft = this.snapshot.drafts[peerID] || EMPTY_DRAFT;
    const content = draft.content.trim();
    if (!peerID || (!file && (!content || [...content].length > 4000))) return;
    const item: OutgoingMessage = {
      id: ++this.sequence, peerID, content: file ? file.name : content, file,
      replyToID: file ? undefined : draft.replyTo?.id,
      editID: file ? undefined : draft.editing?.id,
      status: "sending",
    };
    this.publish({
      drafts: file ? this.snapshot.drafts : { ...this.snapshot.drafts, [peerID]: EMPTY_DRAFT },
      outgoing: [...this.snapshot.outgoing, item],
    });
    return item;
  }
  retry(id: number) {
    const item = this.snapshot.outgoing.find((entry) => entry.id === id);
    if (!item || item.status !== "failed") return;
    const next = { ...item, status: "sending" as const };
    this.publish({ ...this.snapshot, outgoing: this.snapshot.outgoing.map((entry) => entry.id === id ? next : entry) });
    return next;
  }
  fail(id: number) {
    this.publish({ ...this.snapshot, outgoing: this.snapshot.outgoing.map((item) => item.id === id ? { ...item, status: "failed" } : item) });
  }
  remove(id: number) {
    this.publish({ ...this.snapshot, outgoing: this.snapshot.outgoing.filter((item) => item.id !== id) });
  }
}
