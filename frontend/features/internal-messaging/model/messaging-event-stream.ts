export type MessagingEventWithMID = { mid?: number };

type EventStreamResponse = {
  body?: ReadableStream<Uint8Array> | null;
};

type MessagingEventStreamOptions<Event extends MessagingEventWithMID> = {
  openStream: (
    afterMID: number | undefined,
    signal: AbortSignal,
  ) => Promise<EventStreamResponse>;
  onEvent: (event: Event) => void;
  onConnectionChange?: (connected: boolean) => void;
  retryDelayMS?: number;
};

export function createJSONEventStreamParser<Event>(onEvent: (event: Event) => void) {
  let pending = "";

  const dispatch = (frame: string) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (data.length === 0) return;
    try {
      onEvent(JSON.parse(data.join("\n")) as Event);
    } catch {
      // VoceChat heartbeats and malformed optional events are intentionally ignored.
    }
  };

  return {
    push(chunk: string) {
      pending += chunk;
      let delimiter = /\r?\n\r?\n/.exec(pending);
      while (delimiter) {
        dispatch(pending.slice(0, delimiter.index));
        pending = pending.slice(delimiter.index + delimiter[0].length);
        delimiter = /\r?\n\r?\n/.exec(pending);
      }
    },
    finish() {
      if (pending.trim()) dispatch(pending);
      pending = "";
    },
  };
}

export function startMessagingEventStream<Event extends MessagingEventWithMID>({
  openStream,
  onEvent,
  onConnectionChange,
  retryDelayMS = 1500,
}: MessagingEventStreamOptions<Event>) {
  let stopped = false;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let latestMID = 0;

  const connect = async () => {
    controller = new AbortController();
    try {
      const response = await openStream(
        latestMID || undefined,
        controller.signal,
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("event stream is unavailable");
      onConnectionChange?.(true);
      const decoder = new TextDecoder();
      const parser = createJSONEventStreamParser<Event>((event) => {
        if (typeof event.mid === "number") {
          latestMID = Math.max(latestMID, event.mid);
        }
        onEvent(event);
      });
      while (!stopped) {
        const next = await reader.read();
        if (next.done) break;
        parser.push(decoder.decode(next.value, { stream: true }));
      }
      parser.push(decoder.decode());
      parser.finish();
    } catch {
      // A bounded retry below covers service startup and transient disconnects.
    }
    onConnectionChange?.(false);
    if (!stopped) retryTimer = setTimeout(connect, retryDelayMS);
  };

  void connect();
  return () => {
    stopped = true;
    controller?.abort();
    if (retryTimer) clearTimeout(retryTimer);
    onConnectionChange?.(false);
  };
}
