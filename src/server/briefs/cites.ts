import { checkoutById, checkoutContent } from "../run-checkouts.js";
import { verificationById, verificationContent } from "../run-verifications.js";
import { db } from "../db.js";
import { READABLE_MAIL_SQL } from "../mail-context.js";
import type { Cite } from "./schema.js";
import { watchProject } from "./store.js";

export type ResolvedCite = {
  kind: "result" | "message" | "saved" | "approval" | "pr" | "checkout" | "verification";
  content: string;
  role?: string;
  automated?: boolean;
  state?: string;
  runId?: string;
  runCreatedAt?: number;
  recordedAt?: number;
  agent?: string;
  merged?: boolean;
  saved?: boolean;
  conversation?: string | null;
  message?: string | null;
  artifact?: string;
};
/** Exactly the highlighted-excerpt rule: trim the quote, not stored content. */
export function checkQuote(content: string, quote?: string) {
  const part = quote?.trim();
  return !part || content.includes(part);
}
function inScope(owner: string, project: string, source: string, ref: string) {
  return !!db
    .prepare(
      "SELECT 1 FROM project_change_sources WHERE owner_id=? AND project_id=? AND source=? AND ref=?",
    )
    .get(owner, project, source, ref);
}
function runInfo(runId: string | null, owner: string) {
  const r = db
    .prepare(
      "SELECT id,created_at,agent_id,conversation_id FROM runs WHERE id=? AND owner_id=?",
    )
    .get(runId, owner) as
    | {
        id: string;
        created_at: number;
        agent_id: string;
        conversation_id: string | null;
      }
    | undefined;
  return r
    ? {
        runId: r.id,
        runCreatedAt: r.created_at,
        agent: r.agent_id,
        conversation: r.conversation_id,
      }
    : {};
}
export function resolveCite(
  owner: string,
  project: string,
  cite: Cite,
): ResolvedCite | null {
  const split = cite.ref.indexOf("_"),
    prefix = cite.ref.slice(0, split),
    id = cite.ref.slice(split + 1);
  if (prefix === "ver") {
    const verification = verificationById(owner, id);
    if (!verification) return null;
    const scope = db
      .prepare(
        `SELECT f.project_id FROM runs r
         LEFT JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
         JOIN project_change_folders f ON f.owner_id=r.owner_id
           AND f.folder_id IS COALESCE(c.project_id,json_extract(r.payload,'$.folderId'))
         WHERE r.id=? AND r.owner_id=? AND (r.conversation_id IS NULL OR c.id IS NOT NULL)`,
      )
      .get(verification.run_id, owner) as { project_id: string } | undefined;
    if (scope?.project_id !== project) return null;
    const run = runInfo(verification.run_id, owner);
    return {
      kind: "verification",
      content: verificationContent(verification),
      ...run,
      conversation: verification.conversation_id ?? run.conversation,
      recordedAt: verification.observed_at,
    };
  }
  if (prefix === "chk") {
    // A checkout record is scoped like the run that produced it: the
    // conversation's project first, then the run's folder.
    const checkout = checkoutById(owner, id);
    // A capture still in progress is not evidence yet.
    if (!checkout || !checkout.ended_at) return null;
    const scope = db
      .prepare(
        `SELECT f.project_id FROM runs r
         LEFT JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
         JOIN project_change_folders f ON f.owner_id=r.owner_id
           AND f.folder_id IS COALESCE(c.project_id,json_extract(r.payload,'$.folderId'))
         WHERE r.id=? AND r.owner_id=? AND (r.conversation_id IS NULL OR c.id IS NOT NULL)`,
      )
      .get(checkout.run_id, owner) as { project_id: string } | undefined;
    if (scope?.project_id !== project) return null;
    const run = runInfo(checkout.run_id, owner);
    return {
      kind: "checkout",
      content: checkoutContent(checkout),
      ...run,
      conversation: checkout.conversation_id ?? run.conversation,
      recordedAt: checkout.ended_at ?? checkout.started_at,
    };
  }
  if (prefix === "res") {
    if (!inScope(owner, project, "artifact", id)) return null;
    const a = db
      .prepare(
        `SELECT a.content,a.run_id,a.pinned,a.conversation_id,json_extract(a.metadata,'$.messageId') message_id,COALESCE((SELECT min(c.at) FROM project_changes c
        WHERE c.owner_id=a.owner_id AND c.kind='result' AND c.ref=a.id),a.created_at) recorded_at
      FROM artifacts a JOIN artifact_publications p ON p.artifact_id=a.id
      WHERE a.id=? AND a.owner_id=? AND a.archived=0`,
      )
      .get(id, owner) as
      | {
          content: string;
          run_id: string | null;
          recorded_at: number;
          pinned: number;
          conversation_id: string | null;
          message_id: string | null;
        }
      | undefined;
    return a
      ? {
          kind: "result",
          content: a.content,
          recordedAt: a.recorded_at,
          ...runInfo(a.run_id, owner),
          saved: !!a.pinned,
          conversation: a.conversation_id,
          message: a.message_id,
          artifact: id,
        }
      : null;
  }
  if (prefix === "msg" || prefix === "saved") {
    if (!inScope(owner, project, "message", id)) return null;
    const m = db
      .prepare(
        `SELECT content,role,metadata,run_id,conversation_id,created_at,
        (EXISTS(SELECT 1 FROM delegations d WHERE d.child_run_id=m.run_id)
          OR EXISTS(SELECT 1 FROM workflow_steps w WHERE w.child_run_id=m.run_id)) generated
      FROM messages m WHERE id=? AND owner_id=?
      AND role IN ('user','assistant') AND json_extract(metadata,'$.partial') IS NOT 1 AND length(trim(content))>0
      AND ${READABLE_MAIL_SQL}`,
      )
      .get(id, owner) as
      | {
          content: string;
          role: string;
          metadata: string;
          run_id: string | null;
          generated: number;
          conversation_id: string;
          created_at: number;
        }
      | undefined;
    if (!m) return null;
    const message: ResolvedCite = {
      kind: "message",
      content: m.content,
      role: m.role,
      automated: !!m.generated || JSON.parse(m.metadata).automation != null,
      ...runInfo(m.run_id, owner),
      conversation: m.conversation_id,
      message: id,
      recordedAt: m.created_at,
    };
    if (prefix === "msg") return message;
    if (
      db
        .prepare(
          "SELECT 1 FROM message_bookmarks WHERE owner_id=? AND message_id=?",
        )
        .get(owner, id)
    )
      return { ...message, kind: "saved" };
    // A saved result is addressed by its originating message, as setSaved does.
    const a = db
      .prepare(
        `SELECT a.content,a.run_id FROM artifacts a JOIN project_change_sources s ON s.source='artifact' AND s.ref=a.id
      WHERE a.owner_id=? AND s.project_id=? AND a.pinned=1 AND a.archived=0 AND json_extract(a.metadata,'$.messageId')=?
      ORDER BY a.updated_at DESC,a.id LIMIT 1`,
      )
      .get(owner, project, id) as
      { content: string; run_id: string | null } | undefined;
    return a
      ? {
          ...message,
          kind: "saved",
          content: a.content,
          ...runInfo(a.run_id, owner),
        }
      : null;
  }
  if (prefix === "approval") {
    if (!inScope(owner, project, "approval", id)) {
      if (!inScope(owner, project, "decision", id)) return null;
      const decision = db
        .prepare(
          `SELECT d.request,d.state,d.run_id FROM native_decisions d
        JOIN runs r ON r.id=d.run_id AND r.owner_id=? WHERE d.id=?`,
        )
        .get(owner, id) as
        | {
            request: string;
            state: string;
            run_id: string;
          }
        | undefined;
      // The request and its resolution state are citable. The answer remains
      // harness-owned; resolved does not establish that permission was granted.
      return decision
        ? {
            kind: "approval",
            content: decision.request,
            state: decision.state,
            ...runInfo(decision.run_id, owner),
          }
        : null;
    }
    const a = db
      .prepare(
        "SELECT request,state,run_id FROM approvals WHERE id=? AND owner_id=?",
      )
      .get(id, owner) as
      { request: string; state: string; run_id: string } | undefined;
    return a
      ? {
          kind: "approval",
          content: a.request,
          state: a.state,
          ...runInfo(a.run_id, owner),
        }
      : null;
  }
  if (prefix !== "pr") return null;
  const match = /^(\d+):c_(.+)$/.exec(id);
  if (!match) return null;
  // The compact PR reference must identify a single watch/event in this project;
  // the same PR number in another repository cannot silently supply evidence.
  const observations = db
    .prepare(
      `SELECT p.at,p.ref,p.project_id,w.* FROM project_changes p JOIN pr_watches w
    ON w.owner_id=p.owner_id AND p.ref IN (w.id||':comment:'||@item,w.id||':review_comment:'||@item,w.id||':review:'||@item,w.id||':merged:'||@item,w.id||':closed:'||@item,w.id||':ci_failure:'||@item,w.id||':ci_success:'||@item)
    WHERE p.owner_id=@owner AND p.kind='pr_update' AND w.number=@number`,
    )
    .all({ owner, number: Number(match[1]), item: match[2] }) as {
    id: string;
    conversation_id: string;
    project_id: string;
    ended_reason: string | null;
    at: number;
    ref: string;
  }[];
  const valid = observations.filter(
    (r) => watchProject(owner, r.id, r.project_id) === project,
  );
  const identities = new Set(valid.map((r) => r.ref));
  if (identities.size !== 1) return null;
  const observation = valid.at(-1)!;
  const merged = observation.ended_reason?.toLowerCase() === "merged";
  if (/:(merged|closed):/.test(observation.ref))
    return {
      kind: "pr",
      content: observation.ended_reason ?? "",
      merged,
      conversation: observation.conversation_id,
      recordedAt: observation.at,
    };
  // The migration binds events to their durable automated source message.
  // Rate-limit delivery rows can be deleted when a watch resumes.
  const bodies = db
    .prepare(
      `SELECT m.id,m.content FROM messages m
    WHERE m.owner_id=? AND m.conversation_id=? AND m.role='user'
      AND json_extract(m.metadata,'$.automation.watchId')=?
      AND EXISTS(SELECT 1 FROM json_each(m.metadata,'$.brief_pr_refs') WHERE value=?)`,
    )
    .all(
      owner,
      observation.conversation_id,
      observation.id,
      observation.ref,
    ) as {
    content: string;
    id: string;
  }[];
  return bodies.length === 1
    ? {
        kind: "pr",
        content: bodies[0].content,
        merged: false,
        conversation: observation.conversation_id,
        message: bodies[0].id,
        recordedAt: observation.at,
      }
    : null;
}
