export function mergeMessages<T extends { id: number }>(...groups: T[][]): T[] {
  const byID = new Map<number, T>();
  for (const group of groups) {
    for (const message of group) byID.set(message.id, message);
  }
  return [...byID.values()].sort((left, right) => left.id - right.id);
}

export type SelectedConversationLiveEvent<T extends { id: number }> = {
  loaded: T[];
  incoming: T;
  reaction: boolean;
};

export type SelectedConversationLiveEventResult<T extends { id: number }> = {
  messages: T[];
  changed: boolean;
  advanceReadCursor: boolean;
  mergedAsTail: boolean;
};

export function applySelectedConversationLiveEvent<T extends { id: number }>(
  event: SelectedConversationLiveEvent<T>,
): SelectedConversationLiveEventResult<T> {
  const loadedIDs = new Set(event.loaded.map((message) => message.id));
  const maximumID = event.loaded.reduce(
    (maximum, message) => Math.max(maximum, message.id),
    0,
  );
  const inWindow = loadedIDs.has(event.incoming.id);

  if (event.reaction) {
    if (!inWindow) {
      return {
        messages: event.loaded,
        changed: false,
        advanceReadCursor: false,
        mergedAsTail: false,
      };
    }
    return {
      messages: mergeMessages(event.loaded, [event.incoming]),
      changed: true,
      advanceReadCursor: false,
      mergedAsTail: false,
    };
  }

  if (event.incoming.id > maximumID) {
    return {
      messages: mergeMessages(event.loaded, [event.incoming]),
      changed: true,
      advanceReadCursor: true,
      mergedAsTail: true,
    };
  }

  if (inWindow) {
    return {
      messages: mergeMessages(event.loaded, [event.incoming]),
      changed: true,
      advanceReadCursor: false,
      mergedAsTail: false,
    };
  }

  return {
    messages: event.loaded,
    changed: false,
    advanceReadCursor: false,
    mergedAsTail: false,
  };
}
