import { ConversationId } from "../shared/contract-ids.js";
import { listenWorkspaceChanges } from "./workspace-changes";
import { useSourceId } from "./SourceContext";
import { useEffect, useRef, useState } from "react";
import { ActivityHistory, type ActivityHistoryState } from "./activityHistory";
import type { ActivityRecord } from "../shared/agent-activities";
import { readRoute } from "./api";
import { viewGeneration } from "./viewCache";
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
  T extends Pick<ActivityItem, "key" | "sequence">,
>(current: T[], page: { items: T[] }) {
  const byKey = new Map(current.map((item) => [item.key, item]));
  for (const item of page.items) {
    const old = byKey.get(item.key);
    // Pages can overlap after a reconnect; an older sequence never wins.
    if (!old || item.sequence >= old.sequence) byKey.set(item.key, item);
  }
  return [...byKey.values()].sort(
    (a, b) => a.sequence - b.sequence || a.key.localeCompare(b.key),
  );
}

export function visibleActivities(items: ActivityItem[]) {
  return items.filter(
    (i): i is ActivityItem & { record: ActivityRecord } =>
      i.record.v === 1 && i.record.kind !== "capabilities",
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
  const generation = viewGeneration();
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
      (query, mode, signal) =>
        readRoute(
          workspaceApi.conversationActivities,
          {
            params: { id: ConversationId.parse(conversation) },
            query,
          },
          sourceId,
          signal,
          undefined,
          mode,
        ),
      (page) => setItems((old) => mergeActivities(old, page)),
      setHistory,
      tools,
      () => generation === viewGeneration(),
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
    update();
    return () => {
      current.stop();
      if (loader.current === current) loader.current = null;
      stopChanges();
    };
  }, [conversation, tools, sourceId, generation]);
  useEffect(() => {
    void loader.current?.setRuns(runKey ? runKey.split(",") : []);
  }, [conversation, runKey, tools, sourceId, generation]);
  return {
    items,
    ...history,
    loadEarlier: () => loader.current?.loadEarlier(),
    retry: () => loader.current?.retry(),
  };
}
