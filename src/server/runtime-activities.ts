import { observeCompletedOutput } from "./run-verifications.js";
import {
  claudeActivities,
  codexActivities,
  directUpdates,
  type DirectActivity,
} from "../adapters/direct-activities.js";
import type { Chunk } from "./providers.js";
import type { Run } from "./queue.js";
import { applyActivity } from "./activities.js";

// Maps structured executor results from a subscription runtime (Codex
// app-server items/plans, Claude Code tool blocks) into shared activities for
// an API-runtime run. The same extractors serve the direct native adapters,
// so a command or file change renders identically whichever path ran it.
//
// The runtime is Loop's own executor, but its payload is still validated: the
// extractors read only known fields, and applyActivity validates and bounds
// every update. Records are scoped to the run from trusted server context and
// never apply a change or run a command.
export function runtimeActivityMapper(
  run: Run,
  // Features an earlier run of this conversation already received.
  initial: Iterable<"output" | "diffs" | "plans"> = [],
) {
  // Claude results are correlated with their tool_use within this run only.
  const invocations = new Map<string, { name: string; input: any }>();
  const origins = new Set<"output" | "diffs" | "plans">(initial);
  return {
    // Features this run has actually received structured data for.
    get reported() {
      return origins;
    },
    apply(activity: NonNullable<Chunk["activity"]>) {
      let values: DirectActivity[] = [];
      if (activity.harness === "codex" && typeof activity.method === "string")
        values = codexActivities(activity.method, activity.params ?? {});
      else if (activity.harness === "claude" && activity.block) {
        const block = activity.block;
        if (block.type === "tool_use" && typeof block.id === "string") {
          if (invocations.size < 1000 && block.name !== "TodoWrite")
            invocations.set(block.id, { name: block.name, input: block.input });
          values = claudeActivities(block);
        } else if (block.type === "tool_result") {
          const invocation = invocations.get(block.tool_use_id);
          invocations.delete(block.tool_use_id);
          values = claudeActivities(block, invocation);
        }
      }
      let applied = 0;
      for (const update of directUpdates(activity.harness, values, {
        transport: "api",
        origin: `${activity.harness}:runtime`,
      })) {
        const result = applyActivity(
          {
            owner: run.owner_id,
            conversation: run.conversation_id,
            run: run.id,
          },
          update,
        );
        if (result.applied || result.reason === "no change") {
          applied++;
          origins.add(
            update.kind === "output"
              ? "output"
              : update.kind === "file_change"
                ? "diffs"
                : "plans",
          );
        }
        if (
          result.applied &&
          result.record.kind === "output" &&
          !update.replay
        ) {
          // Verification must not hold up provider stream consumption.
          void import("./pr-watches.js")
            .then(({ watchCompletedOutput }) =>
              watchCompletedOutput(
                run,
                result.record
                  .data as import("../agent-activities.js").OutputData,
              ),
            )
            .catch(() => {});
          try {
            observeCompletedOutput(
              run,
              result.record.data as import("../agent-activities.js").OutputData,
              () => true,
              null,
              result.record.id,
            );
          } catch {}
        }
      }
      return applied;
    },
  };
}
