import type { NormalizedSourceEvent } from "./contracts";

export function deduplicateEvents(events: NormalizedSourceEvent[]) {
  const seen = new Set<string>();

  return events.filter((event) => {
    const key = `${event.source}:${event.sourceEventId}:${event.rawPayloadHash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
