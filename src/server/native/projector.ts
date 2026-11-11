import { withoutBusyWait } from "../busy-wait.js";
import { reportBackgroundFailure } from "../background-failure.js";
import * as nativeDecisionsQueries from "../sql/native-decisions.js";
import * as companionSessionsQueries from "../sql/companion-sessions.js";
import * as nativeItemsQueries from "../sql/native-items.js";
import * as nativeDispatchQueries from "../sql/native-dispatch.js";
import * as connectionsQueries from "../sql/connections.js";
import * as agentCheckpointsQueries from "../sql/agent-checkpoints.js";
import * as artifactsQueries from "../sql/artifacts.js";
import * as artifactVersionsQueries from "../sql/artifact-versions.js";
import * as runsQueries from "../sql/runs.js";
import * as messagesQueries from "../sql/messages.js";
import { MessageMetadata, agentPayload } from "../row-schemas.js";

import { observeCompletedOutput } from "../run-verifications.js";

import { createHash } from "node:crypto";
import { db, emit, now } from "../db.js";
import { recordConversationUpdate } from "../conversation-updates.js";
import { recordTrace } from "../traces.js";
import { transition } from "../queue.js";

import type { AdapterEvent } from "../../adapters/events.js";
import { type Item } from "../../shared/protocol.js";
import {
  MAX_NATIVE_REQUEST_BYTES,
  MAX_NATIVE_EVENT_BYTES,
} from "../../shared/workspace-events.js";
import {
  ingestNativeActivity,
  ingestNativeCapabilities,
} from "../activities.js";
import { type Live } from "./state.js";
import { requestApproval, type NativeDecisions } from "./decisions.js";

type Context = {
  live: ReadonlyMap<string, Live>;
  interrupt(runId: string, reason?: string): Promise<void>;
  dispose(live: Live): Promise<void>;
  request: NativeDecisions["request"];
  projectOutput(live: Live, partial: boolean): void;
};

// Native tools can return far more text than the phone needs to display. Keep
// a bounded tail in Loop's projection; the harness still owns the full output.
function displayText(text: string) {
  const limit = 64000;
  if (Buffer.byteLength(JSON.stringify(text)) <= limit) return text;
  const notice = "[Earlier native output omitted from this preview.]\n";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const keep = Math.ceil((low + high) / 2);
    const candidate = notice + text.slice(-keep);
    if (Buffer.byteLength(JSON.stringify(candidate)) <= limit) low = keep;
    else high = keep - 1;
  }
  return notice + (low ? text.slice(-low) : "");
}

export class NativeProjector {
  constructor(private readonly context: Context) {}

  /** @internal Adapter event entry point. */
  event(live: Live, input: AdapterEvent) {
    if (live.closed) return;
    if (this.context.live.get(live.binding.conversation_id) !== live) return;
    if (input.type === "usage") {
      const run = live.run;
      const current = companionSessionsQueries.generation(
        db,
        live.binding.conversation_id,
      );
      const usage = input.usage;
      if (
        !run ||
        run.conversation_id !== live.binding.conversation_id ||
        current?.generation !== live.generation ||
        !usage ||
        !Number.isSafeInteger(usage.input_tokens) ||
        usage.input_tokens < 0 ||
        !Number.isSafeInteger(usage.output_tokens) ||
        usage.output_tokens < 0
      )
        return;
      // Cumulative for this Loop turn, separate from API message receipts.
      // Never persist arbitrary adapter fields in the public event stream.
      emit(run.owner_id, run.id, "native.usage", {
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
        },
      });
      return;
    }
    if (input.type === "activity" || input.type === "activity_capabilities") {
      this.activity(live, input);
      return;
    }
    // Project display text before checking event size. An oversized tool
    // result is not an oversized approval and must not cancel native work.
    // Apply standing consent before display limits. A tool confirmation can
    // contain entire files (for example GitHub create_tree). Only a request
    // already authorized by Never ask may have its audit preview abbreviated;
    // manual decisions and forms must remain completely reviewable.
    // A session's own mode takes precedence over the workspace setting.
    const allow = requestApproval(live, input);
    const event = structuredClone(input);
    if (
      event.type === "request" &&
      allow &&
      Buffer.byteLength(JSON.stringify(event.request)) >
        MAX_NATIVE_REQUEST_BYTES
    ) {
      const detail = event.request.detail;
      const digest = createHash("sha256").update(detail).digest("hex");
      event.request.detail = [
        "[Automatically approved by Never ask; oversized details abbreviated for display.]",
        `Full detail: ${Buffer.byteLength(detail)} bytes; SHA-256 ${digest}`,
        detail.slice(0, 2000),
        "[Details omitted from this preview.]",
        detail.slice(-1000),
      ].join("\n");
      // The adapter retains the original native request. IDs, choices and
      // durable delivery receipts still use the existing answer path.
    }
    if (event.type === "item") event.item.text = displayText(event.item.text);
    if (event.type === "delta") event.text = displayText(event.text);
    if (Buffer.byteLength(JSON.stringify(event)) > MAX_NATIVE_EVENT_BYTES) {
      // Item metadata is display data too. Dropping an unrepresentable preview
      // must not cancel the harness; decisions retain their stricter bounds.
      if (event.type === "item" || event.type === "delta") return;
      if (live.run)
        void this.context.interrupt(
          live.run.id,
          event.type === "request"
            ? "Native decision exceeds safe display bounds."
            : "Native output exceeded safe display bounds.",
        );
      // Oversized replay entries are skipped; native history remains authoritative.
      else if (input.type !== "item" && input.type !== "delta")
        void this.context.dispose(live);
      return;
    }
    if (event.type === "metadata") {
      if (event.nativeSession && event.nativeSession.length <= 4096) {
        live.binding.native_id = event.nativeSession;
        companionSessionsQueries.setNativeId(
          db,
          event.nativeSession,
          now(),
          live.binding.conversation_id,
        );
      }
      const model =
        typeof event.billing?.model === "string"
          ? event.billing.model.trim()
          : "";
      const current = companionSessionsQueries.generation(
        db,
        live.binding.conversation_id,
      );
      if (
        model &&
        model.length <= 200 &&
        current?.generation === live.generation
      ) {
        // Adapters may report the model while starting, before a turn is
        // attached; the supervisor applies it when the run attaches.
        live.reportedModel = model;
        this.recordModel(live);
      }
      return;
    }
    if ((event.type === "item" || event.type === "delta") && !live.run) {
      // Native history is a projection; it is never fed back as model context.
      if (event.type === "item") {
        if (!live.items.replay(event.item)) return;
        nativeItemsQueries.upsertUnbound(
          db,
          live.binding.conversation_id,
          event.item.id,
          JSON.stringify(event.item),
          now(),
        );
        live.items.dirty.clear();
      }
      return;
    }
    const run = live.run;
    if (!run) {
      if (
        event.type === "status" &&
        (["failed", "stopped"].includes(event.status) ||
          live.adapter.reusable === false)
      )
        void this.context.dispose(live);
      return;
    }
    if (event.type === "item") {
      if (!this.retainItem(live, event.item)) return;
      this.toolActivity(live, event.item);
    }
    if (event.type === "delta") {
      // An active stream can outlive its in-memory display window. Recover
      // only this run's saved projection, including the original item phase.
      let previous = live.items.get(event.id);
      if (!previous) {
        const stored = nativeItemsQueries.runItem(
          db,
          live.binding.conversation_id,
          run.id,
          event.id,
        );
        if (stored) previous = JSON.parse(stored.item) as Item;
      }
      const item = {
        ...(previous || { id: event.id, kind: "assistant" as const }),
        text: displayText((previous?.text || "") + event.text),
      };
      if (!this.retainItem(live, item)) return;
      this.toolActivity(live, item);
    }
    if (event.type === "item" || event.type === "delta") {
      this.scheduleOutput(live);
      return;
    }
    if (event.type === "request") {
      if (!this.context.request(live, run, event, allow)) return;
    }
    if (event.type === "resolved") {
      live.requests.delete(event.id);
      nativeDecisionsQueries.finishRequest(
        db,
        "resolved",
        live.binding.conversation_id,
        live.generation,
        event.id,
      );
      if (!live.requests.size) {
        live.waiting = false;
        transition(run, "running");
      }
    }
    if (
      event.type === "status" &&
      ["completed", "failed", "interrupted", "stopped"].includes(event.status)
    ) {
      const unavailable =
        (event.status === "failed" && !event.recoverable) ||
        live.adapter.reusable === false;
      // The first terminal status settles the turn. A later one (the turn's
      // process failing while it winds down) only retires the session.
      if (
        !nativeDispatchQueries.setState(db, event.status, run.id).changes &&
        nativeDispatchQueries.exists(db, run.id)
      ) {
        if (unavailable) void this.context.dispose(live);
        return;
      }
      // The dispatch is settled now, and a repeated status is ignored above,
      // so the turn must finish even if recording its output throws. A
      // failed projection cannot certify a completed result to the worker.
      let recorded = false;
      try {
        try {
          if (event.detail)
            runsQueries.setError(db, event.detail.slice(0, 2000), run.id);
          this.context.projectOutput(live, event.status !== "completed");
        } finally {
          live.requests.clear();
          live.waiting = false;
          nativeDecisionsQueries.finishPendingRun(db, "expired", run.id);
          companionSessionsQueries.setState(
            db,
            unavailable ? "unavailable" : "idle",
            now(),
            live.binding.conversation_id,
          );
        }
        recorded = true;
      } finally {
        live.finish?.(recorded ? event.status : "interrupted");
        if (unavailable) void this.context.dispose(live);
      }
    }
    if (event.type === "error")
      runsQueries.setError(db, event.message.slice(0, 2000), run.id);
    emit(run.owner_id, run.id, "native.event", {
      conversationId: live.binding.conversation_id,
      generation: live.generation,
      event,
    });
  }
  /** @internal Record the model the harness last reported on the attached
   * run. A native-default choice also updates its catalog entry so agent
   * labels name the model the harness last used instead of the alias. */
  recordModel(live: Live) {
    const run = live.run,
      model = live.reportedModel;
    // Only a native-default turn runs the session's reported model as-is;
    // an explicit model may be applied at prompt time after the report, and
    // its catalog entry already names it.
    if (
      !run ||
      !model ||
      run.payload.model !== "native-default" ||
      run.payload.resolvedModel === model
    )
      return;
    run.payload.resolvedModel = model;
    db.transaction(() => {
      runsQueries.setResolvedModel(db, model, run.id, run.owner_id);
      if (run.payload.connectionId)
        connectionsQueries.setResolvedNativeModel(
          db,
          model,
          run.payload.connectionId,
          run.owner_id,
        );
    })();
  }
  private scheduleOutput(live: Live) {
    if (live.flush || live.closed || !live.run) return;
    const run = live.run;
    live.flush = setTimeout(() => {
      live.flush = undefined;
      if (
        live.closed ||
        live.run !== run ||
        this.context.live.get(live.binding.conversation_id) !== live
      )
        return;
      withoutBusyWait(db, () => {
        try {
          // Display updates can wait for the next tick. A locked database must
          // not block the event loop or escape this timer and kill every run.
          this.context.projectOutput(live, true);
        } catch (error) {
          const code = (error as { code?: string })?.code;
          if (code !== "SQLITE_BUSY" && !code?.startsWith("SQLITE_BUSY_"))
            throw error;
          // projectOutput clears dirty items only after a successful commit.
          // Retry this display projection, never a native command or prompt.
          this.scheduleOutput(live);
        }
      });
      // Aggregate text is copied into several tables. Bound that write rate;
      // terminal statuses still flush immediately through projectOutput.
    }, 1000);
  }
  private toolActivity(live: Live, item: Item) {
    if (item.kind !== "tool" || !live.run) return;
    recordTrace(live.run, item.id, {
      kind: "tool",
      title: item.title || "Native tool",
      content: item.text,
      metadata: { native: true, itemId: item.id, status: item.status },
    });
    const status = item.status;
    this.activity(live, {
      type: "activity",
      activity: {
        v: 1,
        kind: "tool",
        id: createHash("sha256").update(item.id).digest("hex"),
        source: {
          transport: "native",
          harness: live.binding.harness,
          origin: "native:item",
        },
        patch: {
          title: (item.title || "Native tool").slice(0, 500),
          status:
            status === "running" ||
            status === "waiting" ||
            status === "completed" ||
            status === "failed"
              ? status
              : "unknown",
          content: item.text
            ? [{ type: "text", text: item.text.slice(0, 16000) }]
            : [],
          links: { trace: item.id },
        },
      },
    });
  }
  // Trusted activity boundary. Adapters are untrusted display producers: the
  // server supplies owner, conversation, turn and generation, persists the
  // reduced record and publishes only a content-free `activity.updated`
  // signal. Raw activity payloads are never written to the events stream, and
  // display data never interrupts or disposes native work.
  private activity(
    live: Live,
    event: Extract<
      AdapterEvent,
      { type: "activity" } | { type: "activity_capabilities" }
    >,
  ) {
    // A restarted workspace or replaced session owns a different generation;
    // late frames from an older process must not write into its records.
    const current = companionSessionsQueries.generation(
      db,
      live.binding.conversation_id,
    );
    if (current?.generation !== live.generation) return;
    const transport = ["acp", "grok"].includes(live.binding.harness)
      ? "acp"
      : "native";
    if (event.type === "activity_capabilities") {
      ingestNativeCapabilities(live, transport, event.capabilities);
      return;
    }
    const update: unknown = event.activity;
    if (!update || typeof update !== "object") return;
    // Transport is part of the record key. An adapter may not file records
    // under another transport (for example as API-runtime records).
    if (
      (update as { source?: { transport?: unknown } }).source?.transport !==
      transport
    )
      return;
    const kind = (update as { kind?: unknown }).kind;
    // Session-scoped catalogs/settings may arrive during new/load before a
    // turn starts. Run-scoped records are accepted only during their turn:
    // ACP load does not identify the original Loop turn for replayed tools, so
    // those frames are discarded rather than assigned to the bootstrap run or
    // presented as new work. Stored projections remain authoritative.
    if (!live.run && kind !== "settings" && kind !== "commands") return;
    const applied = ingestNativeActivity(live, {
      ...update,
      generation: live.generation,
    });
    if (
      applied.applied &&
      applied.record.kind === "output" &&
      live.run &&
      !(update as { replay?: boolean }).replay &&
      !applied.record.replayed
    ) {
      const run = live.run;
      const data = applied.record.data;
      const generation = live.generation;
      const stillCurrent = () => {
        const current = companionSessionsQueries.generation(
          db,
          run.conversation_id,
        );
        return current?.generation === generation;
      };
      void import("../pr-watches.js")
        .then(({ watchCompletedOutput }) =>
          watchCompletedOutput(run, data, stillCurrent),
        )
        .catch((error) => reportBackgroundFailure("pr-watches.output", error));
      // A test, type-check or lint the agent ran is recorded with the exit
      // Loop saw, whatever that exit was, right behind the activity commit.
      try {
        observeCompletedOutput(
          run,
          data,
          stillCurrent,
          generation,
          applied.record.id,
        );
      } catch (error) {
        reportBackgroundFailure("verification.output", error);
      }
    }
  }
  private retainItem(live: Live, item: Item) {
    if (live.items.set(item.id, item)) return true;
    // Persist dirty progress before rotating the bounded display window.
    // Native execution and its full context remain owned by the harness.
    this.context.projectOutput(live, true);
    // Free a whole window so pressure does not force a flush on every event.
    // Deltas and completion can recover evicted items from the saved projection.
    live.items.clear();
    return live.items.set(item.id, item);
  }
  /** @internal Flush the retained display projection. */
  projectOutput(live: Live, partial: boolean) {
    const run = live.run;
    if (!run) return;
    clearTimeout(live.flush);
    live.flush = undefined;
    const checkpoint = agentCheckpointsQueries.get(db, run.id);
    if (!checkpoint) return;
    let finalItem = !partial
      ? [...live.items.values()].findLast(
          (i) =>
            i.kind === "assistant" && i.phase !== "commentary" && i.text.trim(),
        )
      : undefined;
    if (!partial && !finalItem) {
      // Tool bookkeeping can evict a reply after it was saved. Completion
      // still publishes that run's last non-commentary assistant item.
      const stored = nativeItemsQueries.assistantHistory(
        db,
        live.binding.conversation_id,
        run.id,
      ) as Iterable<{
        item: string;
      }>;
      for (const row of stored) {
        const item = JSON.parse(row.item) as Item;
        // A pending in-memory replacement may have cleared this saved reply
        // or reclassified it as commentary; it already failed the check above.
        if (!live.items.get(item.id) && item.text.trim()) {
          finalItem = item;
          break;
        }
      }
    }
    // Progress remains durable in Messages/Traces. Publish only the last reply
    // after the harness confirms that the turn completed successfully.
    const output = finalItem?.text || "";
    const metadata = JSON.stringify(
      MessageMetadata.parse({
        ...agentPayload(run),
        partial,
        native: true,
        messageId: checkpoint.message_id,
        finalNativeItemId: finalItem?.id,
      }),
    );
    db.transaction(() => {
      if (
        output !== checkpoint.output ||
        checkpoint.stage !== (partial ? "native" : "done")
      ) {
        messagesQueries.updateContentAndMetadata(
          db,
          output,
          metadata,
          checkpoint.message_id,
        );
        artifactsQueries.updateNativeOutput(
          db,
          output,
          metadata,
          now(),
          checkpoint.artifact_id,
        );
        artifactVersionsQueries.updateInitialContent(
          db,
          output,
          checkpoint.artifact_id,
        );
        agentCheckpointsQueries.nativeOutput(
          db,
          output,
          partial ? "native" : "done",
          run.id,
        );
        runsQueries.setResult(db, output, run.id);
      }

      for (const itemId of live.items.dirty) {
        const item = live.items.get(itemId)!;
        nativeItemsQueries.upsertRunItem(
          db,
          live.binding.conversation_id,
          item.id,
          run.id,
          JSON.stringify(item),
          now(),
        );
        if (item.kind === "assistant")
          recordConversationUpdate(run, `native-message:${item.id}`, {
            content: item.text,
            metadata: {
              native: true,
              itemId: item.id,
              phase: item.phase,
              final: false,
            },
          });
        else
          messagesQueries.deleteRunUpdate(
            db,
            run.owner_id,
            run.id,
            `native-message:${item.id}`,
          );
      }
      if (finalItem)
        recordConversationUpdate(run, `native-message:${finalItem.id}`, {
          content: finalItem.text,
          metadata: {
            native: true,
            itemId: finalItem.id,
            phase: finalItem.phase,
            final: true,
          },
        });
      // Message projection triggers publish item and aggregate identities,
      // revisions and bounded append chunks in this same transaction.
    }).immediate();
    live.items.dirty.clear();
  }
}
