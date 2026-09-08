import type { InternalMessagingConversationPage } from "../../../shared/api/internal-messaging.types";

export async function loadConversationPages(
  fetchPage: (page: number, signal: AbortSignal) => Promise<InternalMessagingConversationPage>,
  count: number,
  signal: AbortSignal,
) {
  let snapshot: InternalMessagingConversationPage | undefined;
  let loaded = 0;
  for (let page = 1; page <= count; page++) {
    signal.throwIfAborted();
    const result = await fetchPage(page, signal);
    signal.throwIfAborted();
    const byPeer = new Map(snapshot?.results.map((item) => [item.user.publicID, item]));
    for (const item of result.results) byPeer.set(item.user.publicID, item);
    snapshot = { ...result, results: [...byPeer.values()] };
    loaded = page;
    if (!result.hasMore) break;
  }
  return { snapshot, loaded };
}
