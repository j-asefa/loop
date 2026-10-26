import { listenWorkspaceChanges } from "./workspace-changes";
import { surfaceFallback } from "./workspace-projections";
import { useSourceId, useProjectionRoute } from "./SourceContext";
import { useEffect, useRef, useState } from "react";
import { ActivityHistory, type ActivityHistoryState } from "./activityHistory";
import type { ActivityRecord } from "../agent-activities";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";

// Client side of the shared activity projection. The server has already
// reduced every record, so the client only replaces items by key: a full load
// is the snapshot and `?after=<cursor>` returns records changed since then.
// Refresh, reconnect and completed history therefore render the same records.
export type ActivityPage = RouteResponse<
  typeof workspaceApi.conversationActivities
>;
export type ActivityItem = ActivityPage["items"][number];

export function mergeActivities<
  T extends Pick<ActivityItem, "key" | "sequence" | "legacy">,
>(current: T[], page: { items: T[] }) {
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
    items.flatMap((i) =>
      !i.legacy && i.record.kind === "tool" && i.record.data.links?.trace
        ? [`${i.run}\0${i.record.data.links.trace}`]
        : [],
    ),
  );
  return items.filter(
    (i): i is ActivityItem & { record: ActivityRecord } =>
      i.record.v === 1 &&
      i.record.kind !== "capabilities" &&
      (!i.legacy || !traces.has(`${i.run}\0${i.record.id}`)),
  );
}

// Pair durable controls only with capabilities from the same producer generation.
export function recordedSessionControls(items: ActivityItem[]) {
  const settings = items
    .map((i) => i.record)
    .filter((record) => record.kind === "settings")
    .at(-1);
  const capability = items
    .map((i) => i.record)
    .filter((record) => record.kind === "capabilities")
    .filter(
      (i) =>
        i.generation === settings?.generation &&
        i.source.transport === settings?.source.transport &&
        i.source.harness === settings?.source.harness,
    )
    .at(-1);
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
  const read = useProjectionRoute();
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
      (query) =>
        read(workspaceApi.conversationActivities, {
          params: { id: conversation },
          query,
        }),
      (page) => setItems((old) => mergeActivities(old, page)),
      setHistory,
      tools,
    );
    loader.current = current;
    const update = () => {
      void current.refresh();
    };
    const stopChanges = listenWorkspaceChanges(
      "activities",
      update,
      sourceId,
      conversation,
    );
    const stopFallback = surfaceFallback([sourceId], "workspace", 5000, update);
    update();
    return () => {
      current.stop();
      if (loader.current === current) loader.current = null;
      stopFallback();
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
