import { db, id, now } from "./db.js";
import type { Run } from "./queue.js";
import type { OutputData } from "../agent-activities.js";
import {
  classifyVerification,
  summarize,
  verificationLine,
  type VerificationItem,
  type VerificationStatus,
  type VerificationSummary,
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

export type VerificationRow = {
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

function outcome(data: OutputData): { status: VerificationStatus; exit: number | null } {
  if (data.unavailable) return { status: "unknown", exit: null };
  if (data.status === "exited" && typeof data.exitCode === "number")
    return { status: data.exitCode === 0 ? "passed" : "failed", exit: data.exitCode };
  return { status: "unknown", exit: typeof data.exitCode === "number" ? data.exitCode : null };
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
) {
  if (!data.command || data.status === "running") return;
  const classified = classifyVerification(data.command);
  if (!classified.length) return;
  if (!current()) return;
  const { status, exit } = outcome(data);
  const text = data.chunks.map((c) => c.text).join("");
  const tail = text.length > TAIL_LIMIT ? text.slice(-TAIL_LIMIT) : text;
  const truncated =
    !!data.truncated.upstream || data.truncated.droppedBytes > 0 || data.truncated.droppedChunks > 0;
  // One row per command: a chain's exit is the chain's, so its tools share it.
  const kinds = new Set(classified.map((c) => c.kind));
  const kind = kinds.has("test") ? "test" : kinds.has("typecheck") ? "typecheck" : "lint";
  db.prepare(
    `INSERT INTO run_verifications(id,owner_id,run_id,conversation_id,generation,kind,tools,command,status,exit_code,truncated,output_tail,observed_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id(),
    run.owner_id,
    run.id,
    run.conversation_id,
    generation,
    kind,
    JSON.stringify(classified.map((c) => c.tool)),
    data.command.slice(0, COMMAND_LIMIT),
    status,
    exit,
    truncated ? 1 : 0,
    tail || null,
    now(),
  );
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
  return (
    db
      .prepare("SELECT * FROM run_verifications WHERE owner_id=? AND run_id=? ORDER BY observed_at,rowid")
      .all(owner, runId) as VerificationRow[]
  ).map((row) => ({ ...toItem(row), output_tail: row.output_tail }));
}

/** The card summary, or null when nothing was observed. */
export function verificationSummary(owner: string, runId: string): VerificationSummary | null {
  const rows = db
    .prepare("SELECT * FROM run_verifications WHERE owner_id=? AND run_id=? ORDER BY observed_at,rowid")
    .all(owner, runId) as VerificationRow[];
  return rows.length ? summarize(rows.map(toItem)) : null;
}

export function verificationById(owner: string, verificationId: string) {
  const row = db
    .prepare("SELECT * FROM run_verifications WHERE id=? AND owner_id=?")
    .get(verificationId, owner) as VerificationRow | undefined;
  return row ? { ...toItem(row), output_tail: row.output_tail, run_id: row.run_id, conversation_id: row.conversation_id } : null;
}

/** The brief's citable text for one observation. */
export function verificationContent(item: ReturnType<typeof verificationById> & object) {
  const lines = [
    `Verification observed by Loop for run ${item.run_id}: ${item.tools.join(" + ")} ${item.status}` +
      (item.exit_code !== null ? ` (exit ${item.exit_code})` : " (exit not reported)") + ".",
    `Command: ${item.command}`,
    "The agent chose this command; Loop observed its exit. It does not show which tests exist or that the right ones ran.",
  ];
  if (item.truncated) lines.push("The output Loop saw was cut short.");
  if (item.output_tail) lines.push("Output tail:", item.output_tail);
  return lines.join("\n");
}

/** Lines for the brief generator, one per observation, with refs. */
export function verificationLines(owner: string, runId: string) {
  const items = runVerifications(owner, runId);
  if (!items.length) return "";
  return items
    .map(
      (item) =>
        `[ver_${item.id}] ${item.tools.join(" + ")} ${item.status}${item.exit_code !== null ? ` (exit ${item.exit_code})` : ""}: ${item.command.slice(0, 200)}`,
    )
    .join("\n");
}

export { verificationLine };
