import { z } from "zod";
import { db } from "../db.js";
import { Problem } from "../domain.js";
import type { Run } from "../queue.js";
import { serveBrief } from "./serve.js";
import { active, assertProject, ledger, readState } from "./store.js";
import type { Brief, Item } from "./schema.js";

const sections = [
  "state",
  "decisions",
  "open_questions",
  "unfinished",
] as const;
export const briefToolSchema = z
  .object({
    projectId: z.string().min(1).max(200).optional(),
    section: z.enum(["all", ...sections]).optional(),
    includeIndex: z.boolean().optional(),
  })
  .strict();

/** Use this run's fallback, never a newer run's project in the same thread. */
function runProject(run: Run): string | null {
  const conversation = run.conversation_id
    ? (db
        .prepare(
          "SELECT project_id FROM conversations WHERE id=? AND owner_id=?",
        )
        .get(run.conversation_id, run.owner_id) as
        { project_id: string | null } | undefined)
    : null;
  if (run.conversation_id && !conversation) return null;
  const folder = conversation?.project_id ?? JSON.parse(run.payload).folderId;
  if (folder != null && typeof folder !== "string") return null;
  return (
    (
      db
        .prepare(
          "SELECT project_id FROM project_change_folders WHERE owner_id=? AND folder_id IS ?",
        )
        .get(run.owner_id, folder ?? null) as { project_id: string } | undefined
    )?.project_id ?? null
  );
}

export function agentBriefAccess(run: Run): boolean {
  const project = runProject(run);
  return !!project && readState(run.owner_id, project).enabled === 1;
}

/** Rechecked before replaying a saved tool receipt as well as before a new read. */
export function assertAgentBriefAccess(run: Run, projectId?: string): string {
  const project = runProject(run);
  if (!project)
    throw new Problem(
      400,
      "This run has no project; loop_brief is unavailable.",
    );
  if (!readState(run.owner_id, project).enabled)
    throw new Problem(
      403,
      "The owner has not enabled the brief for this run's project.",
    );
  const target = projectId ?? project;
  assertProject(run.owner_id, target);
  if (!readState(run.owner_id, target).enabled)
    throw new Problem(403, "The owner has not enabled this project's brief.");
  return target;
}

type Section = (typeof sections)[number];
type AgentBrief = Omit<
  Brief,
  "changes" | "pins" | "acknowledged_version" | Section
> &
  Partial<Pick<Brief, Section>> & {
    index?: Pick<Item, "id" | "kind" | "status" | "text">[];
    truncated?: boolean;
    notice?: string;
  };

const maxBytes = 16 * 1024;
function boundedJson(brief: AgentBrief): string {
  const encode = () => JSON.stringify(brief);
  const fits = () => Buffer.byteLength(encode(), "utf8") <= maxBytes;
  if (fits()) return encode();
  brief.truncated = true;
  brief.notice =
    "Trimmed to 16 KB; some entries are omitted. Read a specific section or omit includeIndex for a smaller response.";
  if (Buffer.byteLength(JSON.stringify(brief.headline), "utf8") > maxBytes)
    brief.headline = null;
  if (fits()) return encode();
  // Keep complete entries (including their evidence and citations). Prefer the
  // authored view and live attention over artifact lists and overflow summaries.
  for (const key of [
    "artifacts",
    "index",
    "unfinished",
    "open_questions",
    "decisions",
    "state",
    "needs_you",
  ] as const) {
    const entries = brief[key];
    if (!entries?.length) continue;
    const set = (count: number) =>
      Object.assign(brief, { [key]: entries.slice(0, count) });
    set(0);
    if (!fits()) continue;
    let low = 0,
      high = entries.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      set(mid);
      if (fits()) low = mid;
      else high = mid - 1;
    }
    set(low);
    return encode();
  }
  // A headline may itself carry an arbitrarily large citation list. Omit the
  // whole headline instead of returning words without their supporting record.
  brief.headline = null;
  if (!fits())
    throw new Problem(
      413,
      "Project brief metadata exceeds the 16 KB tool limit.",
    );
  return encode();
}

export function briefForAgent(run: Run, input: unknown = {}): string {
  const args = briefToolSchema.parse(input);
  return db
    .transaction(() => {
      const project = assertAgentBriefAccess(run, args.projectId);
      const state = readState(run.owner_id, project);
      if (
        !db
          .prepare(
            "SELECT 1 FROM project_briefs WHERE owner_id=? AND project_id=? AND version=? AND state='published'",
          )
          .get(run.owner_id, project, state.current_version)
      )
        throw new Problem(
          404,
          "This project has no brief yet. Reading it does not start generation.",
        );
      const { changes, pins, acknowledged_version, ...served } = serveBrief(
        run.owner_id,
        project,
      );
      const visible = new Set(
        sections.flatMap((key) => served[key].map((item) => item.id)),
      );
      const result: AgentBrief = served;
      if (args.section && args.section !== "all")
        for (const key of sections)
          if (key !== args.section) delete result[key];
      if (args.includeIndex)
        result.index = ledger(run.owner_id, project)
          .filter((item) => active(item) && !visible.has(item.id))
          .map(({ id, kind, status, text }) => ({
            id,
            kind,
            status,
            text: Array.from(text).slice(0, 120).join(""),
          }));
      return boundedJson(result);
    })
    .deferred();
}
