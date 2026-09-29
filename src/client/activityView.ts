import { useEffect, useRef, useState } from "react";
import { api } from "./api";
// Type-only: the client bundle does not ship the zod schemas.
import type { ActivityRecord } from "../agent-activities";

// Client side of the shared activity projection. The server has already
// reduced every record, so the client only replaces items by key: a full load
// is the snapshot and `?after=<cursor>` returns records changed since then.
// Refresh, reconnect and completed history therefore render the same records.
export type ActivityItem = {
  key: string;
  kind: ActivityRecord["kind"] | "capabilities";
  run: string | null;
  sequence: number;
  legacy?: boolean;
  record: any;
};
export type ActivityPage = {
  version: number;
  items: ActivityItem[];
  cursor: number;
  more: boolean;
};

export function mergeActivities(
  current: ActivityItem[],
  page: Pick<ActivityPage, "items">,
) {
  const byKey = new Map(current.map((item) => [item.key, item]));
  for (const item of page.items) {
    const old = byKey.get(item.key);
    // Pages can overlap after a reconnect; an older sequence never wins.
    if (!old || old.legacy || item.sequence >= old.sequence)
      byKey.set(item.key, item);
  }
  return [...byKey.values()].sort(
    (a, b) => a.sequence - b.sequence || a.key.localeCompare(b.key),
  );
}

/** Suppress legacy traces once their durable broker record arrives, including across pages. */
export function visibleActivities(items: ActivityItem[]) {
  const traces = new Set(
    items
      .filter((i) => !i.legacy && i.record?.data?.links?.trace)
      .map((i) => `${i.run}\0${i.record.data.links.trace}`),
  );
  return items.filter(
    (i) =>
      i.record?.v === 1 &&
      i.kind !== "capabilities" &&
      (!i.legacy || !traces.has(`${i.run}\0${i.record.id}`)),
  );
}

// Pair durable controls only with capabilities from the same producer generation.
export function recordedSessionControls(items: ActivityItem[]) {
  const settings = items.filter((i) => i.kind === "settings").at(-1)?.record;
  const capability = items
    .filter(
      (i) =>
        i.kind === "capabilities" &&
        i.record.generation === settings?.generation &&
        i.record.source.transport === settings?.source.transport &&
        i.record.source.harness === settings?.source.harness,
    )
    .at(-1)?.record;
  return {
    settings,
    capabilities: capability?.capabilities,
    capabilityGeneration: capability?.generation,
  };
}

// Loads the snapshot, then follows changes on the existing workspace-change
// signal (or a slow poll). Never sends anything that mutates the session.
export function useConversationActivities(conversation: string | undefined) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const cursor = useRef(0);
  useEffect(() => {
    if (!conversation) {
      setItems([]);
      return;
    }
    let stopped = false;
    let busy = false;
    let pending = false;
    cursor.current = 0;
    setItems([]);
    const load = async () => {
      if (stopped) return;
      if (busy) {
        pending = true;
        return;
      }
      busy = true;
      try {
        const base = `/conversations/${encodeURIComponent(conversation)}/activities`;
        let page: ActivityPage;
        do {
          page = await api<ActivityPage>(
            cursor.current ? `${base}?after=${cursor.current}` : base,
          );
          if (stopped) return;
          cursor.current = page.cursor;
          setItems((old) => mergeActivities(old, page));
        } while (page.more);
      } catch {
        // Older desktops lack the endpoint; activities simply stay empty.
      } finally {
        busy = false;
        if (pending && !stopped) {
          pending = false;
          void load();
        }
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    window.addEventListener("loop-workspace-change", load);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("loop-workspace-change", load);
    };
  }, [conversation]);
  return items;
}
