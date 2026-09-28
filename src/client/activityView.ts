import { useEffect, useRef, useState } from "react";
import { api } from "./api";
// Type-only: the client bundle does not ship the zod schemas.
import type { ActivityRecord, ActivityCapabilities } from "../agent-activities";

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

// Props for the shared panels in ActivityPanels.tsx, grouped per run so a
// conversation can place them beside the turn that produced them.
export type ActivityView =
  | {
      key: string;
      run: string | null;
      kind: "plan";
      props: {
        steps: { id: string; text: string; status: string }[];
        explanation?: string | null;
      };
    }
  | {
      key: string;
      run: string | null;
      kind: "file";
      props: {
        path: string;
        oldPath?: string | null;
        patch?: string | null;
        before?: string | null;
        after?: string | null;
        state: string;
        reason?: string | null;
        truncated?: boolean;
      };
    }
  | {
      key: string;
      run: string | null;
      kind: "output";
      props: {
        command?: string | null;
        cwd?: string | null;
        text: string;
        stream?: string;
        exitCode?: number | null;
        signal?: string | null;
        state: string;
        truncated?: boolean;
        omittedBytes?: number;
      };
    }
  | {
      key: string;
      run: string | null;
      kind: "tool";
      props: {
        title: string;
        status: string;
        error?: string;
        text: string;
        artifacts: string[];
      };
    };

export function activityViews(items: ActivityItem[]): ActivityView[] {
  const views: ActivityView[] = [];
  for (const item of items) {
    const record = item.record as ActivityRecord;
    if (!record || record.v !== 1) continue; // unknown future versions are skipped
    const base = { key: item.key, run: item.run };
    if (record.kind === "plan" && record.data.steps.length)
      views.push({
        ...base,
        kind: "plan",
        props: {
          steps: record.data.steps.map((s) => ({
            id: s.id,
            text: s.title,
            status: s.status,
          })),
          explanation: record.data.explanation ?? null,
        },
      });
    else if (record.kind === "file_change")
      record.data.files.forEach((file, index) =>
        views.push({
          key: item.key + "#" + index,
          run: item.run,
          kind: "file",
          props: {
            path: file.path,
            oldPath: file.oldPath ?? null,
            patch: file.patch ?? null,
            // Omitted content stays undefined; explicit null marks create/delete.
            ...(file.before !== undefined && { before: file.before }),
            ...(file.after !== undefined && { after: file.after }),
            state:
              file.operation === "modify"
                ? record.data.state
                : `${record.data.state} · ${file.operation}`,
            reason:
              file.reason ??
              (file.content !== "available"
                ? `Content ${file.content}.`
                : null),
            truncated: file.content === "oversized",
          },
        }),
      );
    else if (record.kind === "output") {
      const d = record.data;
      views.push({
        ...base,
        kind: "output",
        props: {
          command: d.command ?? null,
          cwd: d.cwd ?? null,
          text: d.chunks.map((c) => c.text).join(""),
          stream: d.streams,
          exitCode: d.exitCode ?? null,
          signal: d.signal ?? null,
          state: d.status,
          truncated: d.truncated.droppedBytes > 0 || !!d.truncated.upstream,
          omittedBytes: d.truncated.droppedBytes || undefined,
        },
      });
    } else if (record.kind === "tool")
      views.push({
        ...base,
        kind: "tool",
        props: {
          title: record.data.title || "Tool",
          status: record.data.status,
          error: record.data.error,
          text: record.data.content
            .filter((c) => c.type === "text")
            .map((c) => (c as { text: string }).text)
            .join("\n"),
          artifacts: record.data.content.flatMap((c) =>
            c.type === "artifact" ? [c.artifactId] : [],
          ),
        },
      });
  }
  return views;
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

// Current session capabilities, settings and command catalog (not history).
export function sessionActivities(items: ActivityItem[]) {
  const pick = (kind: string) =>
    items.filter((i) => i.kind === kind).at(-1)?.record;
  return {
    capabilities: pick("capabilities")?.capabilities as
      ActivityCapabilities | undefined,
    settings: pick("settings")?.data?.options as unknown[] | undefined,
    commands: pick("commands")?.data?.commands as unknown[] | undefined,
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
