import * as runVerificationsQueries from "./sql/run-verifications.js";
import { db, id, now } from "./db.js";
import type { Run } from "./queue.js";
import type { OutputData } from "../shared/agent-activities.js";
import {
  chainLength,
  classifyVerification,
  type VerificationItem,
  type VerificationStatus,
} from "../shared/verification.js";

/**
 * Verification Loop observed: a test, type-check or lint command the agent
 * ran, and the exit Loop saw for it. It is an observation of the command's
 * outcome, not the agent's account of it, and not a claim that the right
 * tests ran: the agent chose the command. Failures, unknown exits and cut
 * output are recorded rather than dropped, unlike pull request detection,
 * which only acts on a confirmed success.
 */

const COMMAND_LIMIT = 1000;
const TAIL_LIMIT = 1500;

type VerificationRow = {
  id: string;
  owner_id: string;
  run_id: string;
  conversation_id: string | null;
  generation: string | null;
  kind: VerificationItem["kind"];
  tools: string;
  command: string;
  status: VerificationStatus;
  exit_code: number | null;
  truncated: number;
  output_tail: string | null;
  observed_at: number;
};

/**
 * A reported exit decides: zero passed, nonzero failed, whatever status word
 * accompanies it. No exit is unknown. A nonzero exit from a chain of several
 * commands is unknown too: `cd missing && npm test` exits nonzero without
 * running the tests, and a failed first step says nothing about the later
 * ones. Only a zero exit establishes that every step ran and passed.
 */
function outcome(
  data: OutputData,
  steps: number,
): { status: VerificationStatus; exit: number | null } {
  // Output that was not retained does not change what the exit said.
  const exit = typeof data.exitCode === "number" ? data.exitCode : null;
  if (exit === null) return { status: "unknown", exit };
  if (exit === 0) return { status: "passed", exit };
  return { status: steps > 1 ? "unknown" : "failed", exit };
}

/**
 * Record a completed command when it is verification. `current` says
 * whether the reporting session generation is still the live one; a stale
 * session's output is not evidence about the run.
 */
export function observeCompletedOutput(
  run: Run,
  data: OutputData,
  current: () => boolean = () => true,
  generation: string | null = null,
  sourceId: string | null = null,
) {
  if (!data.command || data.status === "running") return;
  const classified = classifyVerification(data.command);
  if (!classified.length) return;
  if (!current()) return;
  const { status, exit } = outcome(data, chainLength(data.command));
  const text = data.chunks.map((c) => c.text).join("");
  const tail = text.length > TAIL_LIMIT ? text.slice(-TAIL_LIMIT) : text;
  const truncated =
    !!data.truncated.upstream ||
    data.truncated.droppedBytes > 0 ||
    data.truncated.droppedChunks > 0;
  // One row per command: a chain's exit is the chain's, so its tools share it.
  const kinds = new Set(classified.map((c) => c.kind));
  const kind = kinds.has("test")
    ? "test"
    : kinds.has("typecheck")
      ? "typecheck"
      : "lint";
  // One row per invocation: a later update to the same output record (an
  // exit arriving after completion) replaces the observation under the same
  // id, so counts and citations never double.
  runVerificationsQueries.upsert(db, {
    id: id(),
    owner: run.owner_id,
    run: run.id,
    conversation: run.conversation_id,
    generation,
    source: sourceId ?? id(),
    kind,
    tools: JSON.stringify(classified.map((c) => c.tool)),
    command: data.command.slice(0, COMMAND_LIMIT),
    status,
    exit,
    truncated: truncated ? 1 : 0,
    tail: tail || null,
    at: now(),
  });
}

function toItem(row: VerificationRow): VerificationItem {
  return {
    id: row.id,
    kind: row.kind,
    tools: JSON.parse(row.tools),
    command: row.command,
    status: row.status,
    exit_code: row.exit_code,
    truncated: !!row.truncated,
    observed_at: row.observed_at,
  };
}

/** Every verification observed for a run, oldest first, with output tails. */
export function runVerifications(owner: string, runId: string) {
  return runVerificationsQueries
    .forRun(db, owner, runId)
    .map((row) => ({ ...toItem(row), output_tail: row.output_tail }));
}
