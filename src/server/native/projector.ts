import * as runsQueries from "../sql/runs.js";
import { MessageMetadata, agentPayload } from "../row-schemas.js";
import type { QueryRow } from "../query-records.js";
import { observeCompletedOutput } from "../run-verifications.js";

import { createHash } from "node:crypto";
import { db, emit, now } from "../db.js";
import { recordConversationUpdate } from "../conversation-updates.js";
import { recordTrace } from "../traces.js";
import { transition } from "../queue.js";

import { type AdapterEvent, type Item } from "../../protocol.js";
import {
  MAX_NATIVE_REQUEST_BYTES,
  MAX_NATIVE_EVENT_BYTES,
} from "../../shared/workspace-events.js";
import {
  ingestNativeActivity,
  ingestNativeCapabilities,
} from "../activities.js";
import { type Live } from "./state.js";
import {
  finishDecisions,
  requestApproval,
  type NativeDecisions,
} from "./decisions.js";

type Context = {
  live: ReadonlyMap<string, Live>;
  interrupt(runId: string, reason?: string): Promise<void>;
  dispose(live: Live): Promise<void>;
  request: NativeDecisions["request"];
  projectOutput(live: Live, partial: boolean): void;
};

// Native tools can return far more text than the phone needs to display. Keep
// a bounded tail in Loop55's projection; the harness still owns the full output.
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
      const current = db
        .prepare(
          "SELECT generation FROM companion_sessions WHERE conversation_id=?",
        )
        .get(live.binding.conversation_id) as
        { generation: string } | undefined;
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
      // Cumulative for this Loop55 turn, separate from API message receipts.
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
        db.prepare(
          "UPDATE companion_sessions SET native_id=?,updated_at=? WHERE conversation_id=?",
        ).run(event.nativeSession, now(), live.binding.conversation_id);
      }
      const model =
        typeof event.billing?.model === "string"
          ? event.billing.model.trim()
          : "";
      const current = db
        .prepare(
          "SELECT generation FROM companion_sessions WHERE conversation_id=?",
        )
        .get(live.binding.conversation_id) as
        { generation: string } | undefined;
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
        db.prepare(
          "INSERT INTO native_items VALUES(?,?,NULL,?,?) ON CONFLICT(conversation_id,native_id) DO UPDATE SET item=excluded.item,updated_at=excluded.updated_at",
        ).run(
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
      if (event.item.kind === "tool")
        recordTrace(run, event.item.id, {
          kind: "tool",
          title: event.item.title || "Native tool",
          content: event.item.text,
          metadata: {
            native: true,
            itemId: event.item.id,
            status: event.item.status,
          },
        });
    }
    if (event.type === "delta") {
      // An active stream can outlive its in-memory display window. Recover
      // only this run's saved projection, including the original item phase.
      let previous = live.items.get(event.id);
      if (!previous) {
        const stored = db
          .prepare(
            "SELECT item FROM native_items WHERE conversation_id=? AND run_id=? AND native_id=?",
          )
          .get(live.binding.conversation_id, run.id, event.id) as
          { item: string } | undefined;
        if (stored) previous = JSON.parse(stored.item) as Item;
      }
      const item = {
        ...(previous || { id: event.id, kind: "assistant" as const }),
        text: displayText((previous?.text || "") + event.text),
      };
      if (!this.retainItem(live, item)) return;
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
      finishDecisions(
        "resolved",
        "conversation_id=? AND generation=? AND native_id=? AND state IN ('pending','deciding')",
        [live.binding.conversation_id, live.generation, event.id],
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
      if (event.detail)
        runsQueries.setError(db, event.detail.slice(0, 2000), run.id);
      this.context.projectOutput(live, event.status !== "completed");
      live.requests.clear();
      live.waiting = false;
      finishDecisions("expired", "run_id=? AND state='pending'", [run.id]);
      db.prepare("UPDATE native_dispatch SET state=? WHERE run_id=?").run(
        event.status,
        run.id,
      );
      const unavailable =
        (event.status === "failed" && !event.recoverable) ||
        live.adapter.reusable === false;
      db.prepare(
        "UPDATE companion_sessions SET state=?,updated_at=? WHERE conversation_id=?",
      ).run(
        unavailable ? "unavailable" : "idle",
        now(),
        live.binding.conversation_id,
      );
      live.finish?.(event.status);
      if (unavailable) void this.context.dispose(live);
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
        db.prepare(
          "UPDATE connections SET models=(SELECT json_group_array(CASE WHEN json_extract(value,'$.id')='native-default' THEN json_set(value,'$.resolvedModel',?) ELSE json(value) END) FROM json_each(connections.models)) WHERE id=? AND owner_id=? AND json_valid(models)",
        ).run(model, run.payload.connectionId, run.owner_id);
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
      const timeout = db.pragma("busy_timeout", { simple: true }) as number;
      try {
        // Display updates can wait for the next tick. A locked database must
        // not block the event loop or escape this timer and kill every run.
        db.pragma("busy_timeout = 0");
        this.context.projectOutput(live, true);
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code !== "SQLITE_BUSY" && !code?.startsWith("SQLITE_BUSY_"))
          throw error;
        // projectOutput clears dirty items only after a successful commit.
        // Retry this display projection, never a native command or prompt.
        this.scheduleOutput(live);
      } finally {
        db.pragma(`busy_timeout = ${timeout}`);
      }
      // Aggregate text is copied into several tables. Bound that write rate;
      // terminal statuses still flush immediately through projectOutput.
    }, 1000);
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
    const current = db
      .prepare(
        "SELECT generation FROM companion_sessions WHERE conversation_id=?",
      )
      .get(live.binding.conversation_id) as
      { generation: string | null } | undefined;
    if (current?.generation !== live.generation) return;
    const transport = ["acp", "gemini", "grok"].includes(live.binding.harness)
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
    // ACP load does not identify the original Loop55 turn for replayed tools, so
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
        const current = db
          .prepare(
            "SELECT generation FROM companion_sessions WHERE conversation_id=?",
          )
          .get(run.conversation_id) as { generation: string } | undefined;
        return current?.generation === generation;
      };
      void import("../pr-watches.js")
        .then(({ watchCompletedOutput }) =>
          watchCompletedOutput(run, data, stillCurrent),
        )
        .catch(() => {});
      // A test, type-check or lint the agent ran is recorded with the exit
      // Loop55 saw, whatever that exit was, right behind the activity commit.
      try {
        observeCompletedOutput(
          run,
          data,
          stillCurrent,
          generation,
          applied.record.id,
        );
      } catch {}
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
    const checkpoint = db
      .prepare("SELECT * FROM agent_checkpoints WHERE run_id=?")
      .get(run.id) as QueryRow<"agent_checkpoints"> | undefined;
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
      const stored = db
        .prepare(
          `SELECT item FROM native_items WHERE conversation_id=? AND run_id=?
           AND json_extract(item,'$.kind')='assistant'
           AND json_extract(item,'$.phase') IS NOT 'commentary'
           ORDER BY rowid DESC`,
        )
        .iterate(live.binding.conversation_id, run.id) as Iterable<{
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
        db.prepare("UPDATE messages SET content=?,metadata=? WHERE id=?").run(
          output,
          metadata,
          checkpoint.message_id,
        );
        db.prepare(
          "UPDATE artifacts SET content=?,metadata=?,updated_at=? WHERE id=? AND version=1",
        ).run(output, metadata, now(), checkpoint.artifact_id);
        db.prepare(
          "UPDATE artifact_versions SET content=? WHERE artifact_id=? AND version=1",
        ).run(output, checkpoint.artifact_id);
        db.prepare(
          "UPDATE agent_checkpoints SET output=?,stage=? WHERE run_id=?",
        ).run(output, partial ? "native" : "done", run.id);
        runsQueries.setResult(db, output, run.id);
      }
      const put = db.prepare(
        "INSERT INTO native_items VALUES(?,?,?,?,?) ON CONFLICT(conversation_id,native_id) DO UPDATE SET item=excluded.item,run_id=excluded.run_id,updated_at=excluded.updated_at",
      );
      for (const itemId of live.items.dirty) {
        const item = live.items.get(itemId)!;
        put.run(
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
          db.prepare(
            "DELETE FROM messages WHERE owner_id=? AND run_id=? AND update_key=?",
          ).run(run.owner_id, run.id, `native-message:${item.id}`);
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
