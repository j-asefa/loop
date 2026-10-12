import { db, id, now } from "../db.js";
import { owned, Problem } from "../domain.js";
import { isSubscription, streamConnection } from "../subscriptions.js";
import type { Connection } from "../../shared/types.js";
import type { ChatMessage, ToolCall } from "../providers.js";
import { applyOutput, type ApplyResult } from "./apply.js";
import { buildInput, type BriefInput } from "./input.js";
import { SYSTEM_INSTRUCTIONS } from "./prompt.js";
import {
  outputJsonSchema,
  synthesisKinds,
  type ValidationError,
} from "./schema.js";
import {
  claimDue,
  COOLDOWN_MS,
  dueProjects,
  GENERATION_TIMEOUT_MS,
} from "./schedule.js";
import { ledger, readState, selectView, type State } from "./store.js";

class RetryOutput extends Error {
  constructor(readonly result: ApplyResult) {
    super("Retry brief validation");
  }
}
const retryMessage = (errors: ValidationError[]) =>
  "Your previous submit_brief call had these problems. Fix them and call submit_brief again with the complete brief:\n" +
  errors
    .map(
      (e) =>
        `- ${e.code}: item ${e.id || "output"}: ${e.message.replace(/[\r\n]+/g, " ")}`,
    )
    .join("\n");
const summary = (errors: ValidationError[]) =>
  errors
    .map((e) => `${e.code}: ${e.id || "output"}: ${e.message}`)
    .join("\n")
    .slice(0, 3000);
const problem = (error: unknown): ValidationError[] => [
  {
    code: "invalid_output",
    id: "",
    message:
      error instanceof Problem
        ? error.message
        : "The brief provider request failed.",
  },
];

function configuredConnection(state: State): Connection {
  if (!state.connection_id || !state.model)
    throw new Problem(409, "Choose an API connection and model for the brief.");
  const connection = owned<Connection>(
    "connections",
    state.connection_id,
    state.owner_id,
  );
  if (connection.status !== "connected")
    throw new Problem(409, "Reconnect the brief provider first.");
  if (
    isSubscription(connection) ||
    !["openai", "anthropic"].includes(connection.provider)
  )
    throw new Problem(409, "Brief generation requires an API connection.");
  const models = JSON.parse(connection.models) as { id: string }[];
  if (!models.some((model) => model.id === state.model))
    throw new Problem(
      409,
      "Choose an available model from the brief connection.",
    );
  return connection;
}

function currentGeneration(state: State) {
  const current = readState(state.owner_id, state.project_id);
  return {
    current,
    owns: current.generation_id === state.generation_id,
    matches:
      current.enabled === 1 &&
      current.current_version === state.current_version &&
      current.owner_edit_rev === state.owner_edit_rev &&
      current.connection_id === state.connection_id &&
      current.model === state.model,
  };
}

/** Finish only the lease we claimed; changes arriving during IO keep their due date. */
function finish(
  state: State,
  input: BriefInput,
  mode: "success" | "failed" | "discarded",
  error: string | null = null,
) {
  const { current, owns } = currentGeneration(state);
  if (!owns) return;
  const newer = !!db
    .prepare(
      `SELECT 1 FROM project_changes WHERE owner_id=? AND project_id=? AND seq>?
    AND kind IN (SELECT value FROM json_each(?)) LIMIT 1`,
    )
    .get(
      state.owner_id,
      state.project_id,
      input.basisThrough,
      JSON.stringify(synthesisKinds),
    );
  const at = now();
  const due = !current.enabled
    ? null
    : mode === "discarded" || (mode === "success" && input.cut)
      ? at
      : newer
        ? (current.due_at ??
          Math.max(at, (state.last_run_at ?? at) + COOLDOWN_MS))
        : null;
  db.prepare(
    `UPDATE brief_state SET generation_id=NULL,lease_until=NULL,due_at=?,last_error=?
    WHERE owner_id=? AND project_id=? AND generation_id=?`,
  ).run(due, error, state.owner_id, state.project_id, state.generation_id);
}

function failed(state: State, input: BriefInput, errors: ValidationError[]) {
  db.transaction(() => {
    const { owns, matches } = currentGeneration(state);
    if (!owns) return;
    if (!matches) {
      finish(state, input, "discarded");
      return;
    }
    const previous = db
      .prepare(
        "SELECT view FROM project_briefs WHERE owner_id=? AND project_id=? AND version=? AND state='published'",
      )
      .get(state.owner_id, state.project_id, state.current_version) as
      { view: string } | undefined;
    const key = `brief-failed:${state.project_id}:${input.basisThrough}:${state.owner_edit_rev}`;
    // Failed attempts do not consume an owner-visible version or its unique
    // publication key. Negative diagnostic versions preserve their audit rows.
    const diagnostic = (
      db
        .prepare(
          "SELECT min(0,COALESCE(min(version),0))-1 version FROM project_briefs WHERE owner_id=? AND project_id=?",
        )
        .get(state.owner_id, state.project_id) as { version: number }
    ).version;
    db.prepare(
      `INSERT INTO project_briefs(id,owner_id,project_id,version,view,basis_since,basis_through,unincorporated_before,synth_at,
      connection_id,model,built_on_version,owner_edit_rev,state,error,idempotency_key,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'failed',?,?,?) ON CONFLICT(idempotency_key) DO UPDATE SET error=excluded.error`,
    ).run(
      id(),
      state.owner_id,
      state.project_id,
      diagnostic,
      previous?.view ??
        JSON.stringify(
          selectView(ledger(state.owner_id, state.project_id), null),
        ),
      input.basisSince,
      input.basisThrough,
      input.unincorporatedBefore,
      now(),
      state.connection_id,
      state.model,
      state.current_version,
      state.owner_edit_rev,
      summary(errors),
      key,
      now(),
    );
    finish(state, input, "failed", summary(errors));
  }).immediate();
}

function applyAttempt(
  state: State,
  input: BriefInput,
  output: unknown,
  retry: boolean,
): ApplyResult {
  try {
    return db
      .transaction((): ApplyResult => {
        const { owns, matches } = currentGeneration(state);
        if (!owns || !matches) {
          finish(state, input, "discarded");
          return {
            outcome: "discarded",
            reason: "The brief changed during generation",
          };
        }
        const result = applyOutput(state.owner_id, state.project_id, output, {
          builtOnVersion: state.current_version,
          ownerEditRev: state.owner_edit_rev,
          basisThrough: input.basisThrough,
        });
        if (result.outcome === "discarded") {
          finish(state, input, "discarded");
          return result;
        }
        // A first attempt may contain some valid items. Roll back all its writes
        // before the retry so it cannot publish half of a corrected generation.
        if (retry && result.errors.length) throw new RetryOutput(result);
        if (result.outcome === "failed") return result;
        db.prepare(
          `UPDATE brief_state SET basis_since=?,unincorporated_before=?
          WHERE owner_id=? AND project_id=?`,
        ).run(
          input.basisSince,
          input.unincorporatedBefore,
          state.owner_id,
          state.project_id,
        );
        if (result.outcome === "published")
          db.prepare(
            `UPDATE project_briefs SET basis_since=?,unincorporated_before=?,connection_id=?,model=?
          WHERE owner_id=? AND project_id=? AND version=? AND state='published'`,
          ).run(
            input.basisSince,
            input.unincorporatedBefore,
            state.connection_id,
            state.model,
            state.owner_id,
            state.project_id,
            result.version,
          );
        finish(state, input, "success");
        return result;
      })
      .immediate();
  } catch (error) {
    if (error instanceof RetryOutput) return error.result;
    throw error;
  }
}

/** One tracked worker job; each project claims a durable, expiring generation. */
export async function runDueBriefs(
  at = now(),
  shutdown?: AbortSignal,
): Promise<number> {
  let published = 0;
  for (const candidate of dueProjects(at)) {
    if (shutdown?.aborted) break;
    const captured = db
      .transaction(() => {
        const state = claimDue(
          candidate.owner_id,
          candidate.project_id,
          Math.max(at, now()),
        );
        return state ? { state, input: buildInput(state) } : null;
      })
      .immediate();
    if (!captured) continue;
    const { state, input } = captured;
    if (!input.eventCount) {
      db.transaction(() => finish(state, input, "success")).immediate();
      continue;
    }
    const signal = AbortSignal.any([
      AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      ...(shutdown ? [shutdown] : []),
    ]);
    const messages: ChatMessage[] = [{ role: "user", content: input.prompt }];
    let errors: ValidationError[] = [];
    let completed = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let call: ToolCall | undefined;
      try {
        // A failed request can settle after settings or lease ownership change.
        // Recheck before transmitting the captured project input again.
        const { owns, matches } = currentGeneration(state);
        if (!owns || !matches) {
          db.transaction(() => finish(state, input, "discarded")).immediate();
          completed = true;
          break;
        }
        const connection = configuredConnection(state);
        for await (const chunk of streamConnection(connection, {
          model: state.model!,
          instructions: SYSTEM_INSTRUCTIONS,
          messages,
          signal,
          maxTokens: 4096,
          tools: [
            {
              name: "submit_brief",
              description: "Submit the complete project brief.",
              inputSchema: outputJsonSchema,
            },
          ],
          toolChoice: "submit_brief",
        }))
          if (!call && chunk.toolCall?.name === "submit_brief")
            call = chunk.toolCall;
        signal.throwIfAborted();
        const result = applyAttempt(
          state,
          input,
          call?.arguments ?? null,
          attempt === 0,
        );
        if (result.outcome === "discarded") {
          completed = true;
          break;
        }
        errors = result.errors;
        if (attempt === 0 && errors.length) {
          if (call)
            messages.push(
              { role: "assistant", content: "", toolCalls: [call] },
              {
                role: "tool",
                toolCallId: call.id,
                content: retryMessage(errors),
                isError: true,
              },
            );
          else messages.push({ role: "user", content: retryMessage(errors) });
          continue;
        }
        if (result.outcome === "failed") break;
        if (result.outcome === "published") {
          console.log(
            `Loop brief ${state.project_id}: published version ${result.version}`,
          );
          published++;
        }
        completed = true;
        break;
      } catch (error) {
        if (signal.aborted) {
          if (shutdown?.aborted)
            db.transaction(() => finish(state, input, "discarded")).immediate();
          else
            failed(state, input, [
              {
                code: "invalid_output",
                id: "",
                message: "Brief generation timed out.",
              },
            ]);
          completed = true;
          break;
        }
        errors = problem(error);
        if (attempt === 0)
          messages.push({ role: "user", content: retryMessage(errors) });
      }
    }
    if (!completed) failed(state, input, errors);
  }
  return published;
}
