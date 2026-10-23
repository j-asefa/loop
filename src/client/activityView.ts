import { listenWorkspaceChanges } from "./workspace-changes";
import { useSourceId, useSourceApi } from "./SourceContext";
import { useEffect, useRef, useState } from "react";
import { ActivityHistory, type ActivityHistoryState } from "./activityHistory";
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
  earlier?: number | null;
  legacyAvailable?: boolean;
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

// Read recent activity on open; older tools/outputs are requested explicitly.
export function useConversationActivities(
  conversation: string | undefined,
  runs: string[] = [],
  tools = true,
) {
  const api = useSourceApi();
  const sourceId = useSourceId();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [history, setHistory] = useState<ActivityHistoryState>({
    loading: true,
    hasEarlier: false,
    loadingEarlier: false,
    error: "",
  });
  const loader = useRef<ActivityHistory | null>(null);
  const runKey = [...new Set(runs)].sort().join(",");
  useEffect(() => {
    setItems([]);
    setHistory({
      loading: true,
      hasEarlier: false,
      loadingEarlier: false,
      error: "",
    });
    if (!conversation) return;
    const current = new ActivityHistory(
      `/conversations/${encodeURIComponent(conversation)}/activities`,
      (url) => api<ActivityPage>(url),
      (page) => setItems((old) => mergeActivities(old, page)),
      setHistory,
      tools,
    );
    loader.current = current;
    void current.refresh();
    const update = () => {
      void current.refresh();
    };
    const timer = setInterval(update, 5000);
    const stopChanges = listenWorkspaceChanges("activities", update, sourceId, conversation);
    return () => {
      current.stop();
      if (loader.current === current) loader.current = null;
      clearInterval(timer);
      stopChanges();
    };
  }, [conversation, tools, sourceId]);
  useEffect(() => {
    void loader.current?.setRuns(runKey ? runKey.split(",") : []);
  }, [conversation, runKey, tools]);
  return {
    items,
    ...history,
    loadEarlier: () => loader.current?.loadEarlier(),
  };
}
