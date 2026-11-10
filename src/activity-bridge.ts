import type { DirectActivity } from "./adapters/direct-activities.js";
import type { ActivityUpdate } from "./shared/agent-activities.js";

// Converts the direct adapters' structured extractions into shared activity
// updates. Adapters emit the result as `{ type: "activity", activity }`; the
// server supplies conversation, run and owner (see ingestNativeActivity).
//
// Direct extractions are complete snapshots of one item, so plans and file
// sets replace the previous list and output replaces retained chunks. Nothing
// here infers content: absent fields stay absent.
export function directActivityUpdate(
  activity: DirectActivity,
  context: {
    harness: string;
    generation?: string;
    replay?: boolean;
    // Producer label within the source; live adapters use `<harness>:structured`.
    origin?: string;
    transport?: "native" | "api";
  },
): ActivityUpdate {
  const base = {
    v: 1 as const,
    id: activity.id.slice(0, 300),
    source: {
      transport: context.transport || ("native" as const),
      harness: context.harness,
      origin: context.origin || "direct",
    },
    ...(context.generation && { generation: context.generation }),
    ...(context.replay && { replay: true }),
  };
  switch (activity.kind) {
    case "plan":
      return {
        ...base,
        kind: "plan",
        patch: {
          steps: activity.steps.slice(0, 100).map((step, index) => ({
            // Extractors fall back to the list position when upstream has no id.
            id: step.id.slice(0, 300),
            ...(step.id === String(index) && { positional: true }),
            title: step.text.slice(0, 2000),
            status: step.status as "pending",
          })),
          explanation: activity.explanation ?? null,
        },
      };
    case "file": {
      const declined = activity.state === "declined";
      return {
        ...base,
        kind: "file_change",
        patch: {
          // Codex splits one item into `<item>:<index>` records.
          tool: activity.id.replace(/:\d+$/, "").slice(0, 300),
          state:
            activity.state === "executed"
              ? "applied"
              : activity.state === "failed" || declined
                ? "failed"
                : activity.state === "proposed"
                  ? "proposed"
                  : "unknown",
          files: [
            {
              path: activity.path.slice(0, 4096),
              ...(activity.oldPath && {
                oldPath: activity.oldPath.slice(0, 4096),
              }),
              // The extractor's explicit operation (Codex add/delete/move)
              // wins; otherwise infer only from explicit null content.
              operation: activity.operation
                ? activity.operation
                : activity.oldPath
                  ? "rename"
                  : activity.before === null
                    ? "create"
                    : activity.after === null
                      ? "delete"
                      : "modify",
              ...(activity.patch !== undefined && { patch: activity.patch }),
              ...(activity.before !== undefined && { before: activity.before }),
              ...(activity.after !== undefined && { after: activity.after }),
              content: activity.truncated
                ? "oversized"
                : activity.patch === undefined &&
                    activity.before === undefined &&
                    activity.after === undefined
                  ? "unavailable"
                  : "available",
              ...((declined || activity.truncated) && {
                reason: declined
                  ? "The change was declined and not applied."
                  : "The adapter truncated this diff before Loop received it.",
              }),
            },
          ],
        },
      };
    }
    case "output":
      return {
        ...base,
        kind: "output",
        patch: {
          tool: activity.id.slice(0, 300),
          ...(activity.command !== undefined && { command: activity.command }),
          ...(activity.cwd !== undefined && { cwd: activity.cwd }),
          // 16k UTF-16 units stay within the 64 KiB per-chunk byte bound.
          replace: (activity.text.match(/[\s\S]{1,16000}/g) || []).map(
            (text) => ({ stream: activity.stream, text }),
          ),
          status:
            activity.state === "completed"
              ? "exited"
              : activity.state === "failed" || activity.state === "declined"
                ? "failed"
                : "running",
          ...(activity.exitCode !== undefined && {
            exitCode: activity.exitCode,
          }),
          ...(activity.truncated && { upstreamTruncated: true }),
        },
      };
  }
}
