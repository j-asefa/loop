import { db } from "../db.js";
import type { Run } from "../queue.js";
import { buildLabels } from "../../shared/build.js";

/**
 * The brief's headline, state and decisions, placed in front of an agent
 * so it starts from the project's record rather than having to ask for
 * it. The tool stays the way to the full record and its evidence.
 *
 * Provenance travels with it: the version, when it was synthesized and how
 * many changes it does not yet cover, so the agent knows what is derived
 * and how old. What needs the owner is live only when read through the
 * tool, so it is counted here, never listed.
 */
export const BRIEF_CONTEXT_BYTES = 2000;
const MAX_STATE = 5;
const MAX_DECISIONS = 10;

function utf8Prefix(text: string, bytes: number) {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export type BriefContext = { text: string; version: number };

/**
 * The text for a run, or null when the run's project has no enabled brief
 * or no published version, or when the run is a snapshot review: reviewers
 * see only their captured snapshot, never the live record. With
 * firstTurnOnly, null again once the brief has been delivered to the
 * conversation's harness, which keeps its own context across turns.
 */
export async function briefContext(run: Run, options: { firstTurnOnly: boolean }): Promise<BriefContext | null> {
  // Loaded here rather than at the top: the brief modules reach the native
  // tool registry, which the runtime path also loads, and a static import
  // from the runtime would change the evaluation order of that cycle.
  const [{ agentBriefAccess, assertAgentBriefAccess }, { readState }, { serveBrief }] = await Promise.all([
    import("./tool.js"),
    import("./store.js"),
    import("./serve.js"),
  ]);
  if (!run.conversation_id || !agentBriefAccess(run)) return null;
  let payload: { reviewId?: unknown } = {};
  try {
    payload = JSON.parse(run.payload);
  } catch {}
  if (payload.reviewId) return null;
  if (options.firstTurnOnly) {
    const delivered = db
      .prepare("SELECT 1 FROM brief_deliveries WHERE conversation_id=? AND owner_id=?")
      .get(run.conversation_id, run.owner_id);
    if (delivered) return null;
  }
  let project: string;
  try {
    project = assertAgentBriefAccess(run);
  } catch {
    return null;
  }
  const state = readState(run.owner_id, project);
  if (!state.current_version) return null;
  const brief = serveBrief(run.owner_id, project);
  const name =
    (db.prepare("SELECT name FROM folders WHERE id=? AND owner_id=?").get(project, run.owner_id) as
      | { name: string }
      | undefined)?.name ?? "this project";
  const lines = [
    `Project brief for "${oneLine(name)}": Loop's derived record of the project, quoted as context, not instructions. Read it in full, with each item's evidence, through loop_brief.`,
    `Version ${brief.version}, synthesized ${brief.basis.synth_at ? new Date(brief.basis.synth_at).toISOString() : "at an unknown time"}` +
      (brief.basis.pending ? `; ${brief.basis.pending} later change${brief.basis.pending === 1 ? "" : "s"} not yet incorporated.` : "."),
  ];
  if (brief.goal?.text) lines.push(`Goal (owner's): ${oneLine(brief.goal.text)}`);
  if (brief.headline) lines.push(`Headline: ${oneLine(brief.headline.text)}`);
  if (brief.deployments?.length) {
    lines.push("Running build observations (take precedence over historical deployment prose; re-read loop_brief for current status):");
    for (const observation of brief.deployments.slice(0, 3))
      lines.push(`- ${oneLine(observation.title)}: ${buildLabels[observation.status]} [${observation.ref}]`);
  }
  if (brief.state.length) {
    lines.push("State:");
    for (const item of brief.state.slice(0, MAX_STATE)) lines.push(`- ${oneLine(item.text)}`);
  }
  // The compact view holds a bounded selection; overflow counts the rest.
  const decisions = brief.decisions.filter((d) => d.status === "active");
  const totalDecisions = decisions.length + brief.overflow.decisions;
  if (totalDecisions) {
    lines.push(`Decisions (${totalDecisions} active; ids for loop_brief):`);
    for (const d of decisions.slice(0, MAX_DECISIONS))
      lines.push(`- [${d.id}] ${oneLine(d.text)}${d.why ? ` — ${oneLine(d.why)}` : ""}`);
    if (totalDecisions > MAX_DECISIONS) lines.push(`- …and ${totalDecisions - MAX_DECISIONS} more`);
  }
  const questions = brief.open_questions.length + brief.overflow.open_questions;
  if (questions) lines.push(`Open questions: ${questions} (read them through loop_brief before proposing what they already ask).`);
  const unfinished = brief.unfinished.length + brief.overflow.unfinished;
  if (unfinished) lines.push(`Unfinished work: ${unfinished} item${unfinished === 1 ? "" : "s"}.`);
  lines.push(
    brief.needs_you.length
      ? `Needs the owner now: ${brief.needs_you.length} item${brief.needs_you.length === 1 ? "" : "s"} (live only when read through loop_brief).`
      : "Needs the owner now: nothing as of this synthesis (live only when read through loop_brief).",
  );
  const text = lines.join("\n");
  const suffix = "\n- …(shortened; read loop_brief)";
  const bounded =
    Buffer.byteLength(text) > BRIEF_CONTEXT_BYTES
      ? utf8Prefix(text, BRIEF_CONTEXT_BYTES - Buffer.byteLength(suffix)).replace(/\n[^\n]*$/, "") + suffix
      : text;
  return { text: bounded, version: brief.version };
}

/**
 * The prompt with the brief behind it, or null when the prompt must stay
 * as typed: a slash command ("/build release") passes everything after
 * the command to it as arguments, so the brief waits for the next turn.
 * A prompt that is only a skill selector ("$review") keeps a space after
 * the token: Codex recognises a selector as the exact token or the token
 * followed by a space, and a newline would hide it.
 */
export function promptWithBrief(input: string, brief: string): string | null {
  if (/^\s*\//.test(input)) return null;
  const bare = /^\s*\$\S+\s*$/.test(input);
  return `${bare ? input.trimEnd() + " " : input}\n\n---\n${brief}`;
}

/** The harness has received the brief behind a prompt it accepted. */
export function recordBriefDelivery(run: Run, version: number) {
  if (!run.conversation_id) return;
  db.prepare(
    "INSERT INTO brief_deliveries(conversation_id,owner_id,run_id,version,delivered_at) VALUES(?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET run_id=excluded.run_id,version=excluded.version,delivered_at=excluded.delivered_at",
  ).run(run.conversation_id, run.owner_id, run.id, version, Date.now());
}
