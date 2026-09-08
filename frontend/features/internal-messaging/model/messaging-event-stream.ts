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
  maxRetryDelayMS?: number;
  idleTimeoutMS?: number;
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

export function messagingRetryDelay(attempt: number, base = 1500, maximum = 30_000, random = Math.random()) {
  const ceiling = Math.min(maximum, base * 2 ** Math.min(attempt, 10));
  return Math.round(ceiling * (0.5 + random * 0.5));
}

export function startMessagingEventStream<Event extends MessagingEventWithMID>({
  openStream,
  onEvent,
  onConnectionChange,
  retryDelayMS = 1500,
  maxRetryDelayMS = 30_000,
  idleTimeoutMS = 60_000,
}: MessagingEventStreamOptions<Event>) {
  let stopped = false;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let latestMID = 0;
  let failures = 0;

  const connect = async () => {
    if (stopped) return;
    controller = new AbortController();
    const connection = controller;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let connectedAt = 0;
    const watch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => connection.abort(), idleTimeoutMS);
    };
    watch();
    try {
      const response = await openStream(
        latestMID || undefined,
        controller.signal,
      );
      reader = response.body?.getReader();
      if (!reader) throw new Error("event stream is unavailable");
      if (stopped) { await reader.cancel(); return; }
      connectedAt = Date.now();
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
        watch();
        parser.push(decoder.decode(next.value, { stream: true }));
      }
      parser.push(decoder.decode());
      parser.finish();
    } catch {
      // A bounded retry below covers service startup and transient disconnects.
    } finally {
      clearTimeout(idleTimer);
      reader?.releaseLock();
    }
    onConnectionChange?.(false);
    if (connectedAt && Date.now() - connectedAt >= 30_000) failures = 0;
    if (!stopped) retryTimer = setTimeout(connect, messagingRetryDelay(failures++, retryDelayMS, maxRetryDelayMS));
  };

  void connect();
  return () => {
    stopped = true;
    controller?.abort();
    if (retryTimer) clearTimeout(retryTimer);
    onConnectionChange?.(false);
  };
}
