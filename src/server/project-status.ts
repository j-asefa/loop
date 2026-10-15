import { db, now } from "./db.js";
import { Problem } from "./domain.js";
import { feedNeeds, feedWorking } from "./feed-predicates.js";
import { assertProject } from "./briefs/store.js";
import { synthesisKinds } from "./briefs/schema.js";
import { pullStateFromWatch, type WatchRow } from "../shared/pull-state.js";
import { summarize, type VerificationItem } from "../shared/verification.js";
import {
  compareProjectStatus,
  type ProjectStatus,
  type ProjectStatusAction,
  type ProjectStatusPage,
} from "../shared/project-status.js";
import type { PullRequestCard } from "../shared/github.js";

type Options = { project?: string; teams?: string[] };
const priority: Record<ProjectStatusAction["kind"], number> = {
  approve: 0,
  answer: 1,
  resume: 2,
  failed: 3,
  not_sent: 4,
  review: 5,
};
const month = 30 * 24 * 3600_000;

/** One consistent, read-only snapshot. Query count does not grow with projects;
 * neither the Brief page builder nor its acknowledgement path is involved. */
export function projectStatuses(
  owner: string,
  options: Options = {},
): ProjectStatusPage {
  if (options.project) assertProject(owner, options.project);
  return db.transaction(() => build(owner, options)).deferred();
}

function build(owner: string, options: Options): ProjectStatusPage {
  const at = now(),
    teams = options.teams?.length ? options.teams : null;
  const args = {
    owner,
    now: at,
    project: options.project ?? null,
    teams: JSON.stringify(teams),
  };
  const read = <T>(sql: string, extra: Record<string, string> = {}) =>
    db.prepare(sql).all({ ...args, ...extra }) as T[];
  // The nearest project matches the Brief's scope, including nested projects.
  const scope = `WITH scope AS (
    SELECT c.*, f.project_id status_project FROM conversations c
    JOIN project_change_folders f ON f.owner_id=c.owner_id AND f.folder_id=c.feed_folder_id
    WHERE c.owner_id=@owner AND c.feed_visible=1 AND (@project IS NULL OR f.project_id=@project)
      AND (@teams='null' OR c.team_id IN (SELECT value FROM json_each(@teams)))
  )`;
  const projects = new Map<string, ProjectStatus>();
  const projectRows = read<{
    id: string;
    name: string;
    created_at: number;
    enabled: number | null;
    current_version: number | null;
    last_error: string | null;
    last_run_at: number | null;
    view: string | null;
    synth_at: number | null;
    pending: number;
  }>(`SELECT f.id,f.name,f.created_at,s.enabled,s.current_version,s.last_error,s.last_run_at,b.view,b.synth_at,
      (SELECT count(*) FROM project_changes p WHERE p.owner_id=f.owner_id AND p.project_id=f.id
        AND p.seq>COALESCE(s.basis_through,0)
        AND p.kind IN (${synthesisKinds.map((k) => `'${k}'`).join(",")})
        AND (p.kind='saved' OR p.seq>=COALESCE(s.unincorporated_before,b.unincorporated_before,0))) pending
    FROM folders f LEFT JOIN brief_state s ON s.owner_id=f.owner_id AND s.project_id=f.id
    LEFT JOIN project_briefs b ON b.owner_id=f.owner_id AND b.project_id=f.id AND b.version=s.current_version AND b.state='published'
    WHERE f.owner_id=@owner AND f.kind='project' AND (@project IS NULL OR f.id=@project)`);
  for (const p of projectRows)
    projects.set(p.id, {
      id: p.id,
      name: p.name,
      status: "idle",
      last_activity_at: p.created_at,
      older: false,
      counts: { needs: 0, working: 0, queued: 0 },
      actions: [],
      evidence: null,
      pulls: [],
      brief: {
        state: !p.enabled
          ? p.current_version || p.last_run_at
            ? "off"
            : "never"
          : p.last_error
            ? "failed"
            : p.view
              ? "ready"
              : "pending",
        headline: p.view ? (JSON.parse(p.view).headline?.text ?? null) : null,
        synthesized_at: p.synth_at,
        pending: p.pending,
        unfinished: p.view ? 0 : null,
        questions: p.view ? 0 : null,
        blockers: p.view ? 0 : null,
      },
    });
  const add = (project: string, action: ProjectStatusAction) => {
    const p = projects.get(project);
    if (p && !p.actions.some((a) => a.key === action.key))
      p.actions.push(action);
  };
  // Read every active item, including those outside the Brief's bounded view.
  for (const row of read<{
    project_id: string;
    unfinished: number;
    questions: number;
    blockers: number;
  }>(`
    SELECT project_id,sum(kind='unfinished') unfinished,sum(kind='question') questions,
      sum(kind='unfinished' AND length(trim(COALESCE(blocker,'')))>0) blockers
    FROM brief_items WHERE owner_id=@owner AND status='open' AND kind IN ('question','unfinished')
      AND (@project IS NULL OR project_id=@project) GROUP BY project_id`)) {
    const p = projects.get(row.project_id);
    if (p)
      Object.assign(p.brief, {
        unfinished: row.unfinished,
        questions: row.questions,
        blockers: row.blockers,
      });
  }
  // Changes are semantic events; successful watch polling and synthesis do not
  // append one. Scope activity to teams while the recorded Brief stays whole.
  for (const row of read<{ project_id: string; at: number }>(`
    SELECT p.project_id,max(p.at) at FROM project_changes p
    LEFT JOIN conversations c ON c.id=p.conversation_id AND c.owner_id=p.owner_id
    WHERE p.owner_id=@owner AND (@project IS NULL OR p.project_id=@project)
      AND (@teams='null' OR c.team_id IN (SELECT value FROM json_each(@teams))) GROUP BY p.project_id`)) {
    const p = projects.get(row.project_id);
    if (p) p.last_activity_at = Math.max(p.last_activity_at, row.at);
  }
  type Thread = {
    id: string;
    status_project: string;
    feed_run_id: string | null;
    feed_run_state: string | null;
    feed_last_activity_at: number;
    feed_queued: number;
    needs: number;
    working: number;
  };
  const threads =
    read<Thread>(`${scope} SELECT c.id,c.status_project,c.feed_run_id,c.feed_run_state,
    c.feed_last_activity_at,c.feed_queued,${feedNeeds} needs,(${feedWorking}) working FROM scope c`);
  for (const t of threads) {
    const p = projects.get(t.status_project);
    if (!p) continue;
    p.counts.working += Number(!!t.working);
    p.counts.queued += t.feed_queued;
    p.last_activity_at = Math.max(p.last_activity_at, t.feed_last_activity_at);
  }
  // Explicit requests first. A paused/failed run is a fallback, never a second
  // attention item for the same request. Multiple requests retain their ids.
  for (const a of read<{
    id: string;
    conversation: string;
    project: string;
    at: number;
    message: string | null;
  }>(`${scope}
    SELECT a.id,c.id conversation,c.status_project project,a.created_at at,
      COALESCE(
        (SELECT m.id FROM messages m WHERE m.owner_id=@owner AND m.conversation_id=c.id AND m.run_id=a.run_id
          AND m.role='assistant' AND COALESCE(json_extract(m.metadata,'$.progress'),0)=0 ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1),
        (SELECT m.id FROM messages m WHERE m.owner_id=@owner AND m.conversation_id=c.id AND m.run_id=a.run_id
          AND COALESCE(json_extract(m.metadata,'$.progress'),0)=0 ORDER BY m.created_at,m.rowid LIMIT 1)
      ) message
    FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
    JOIN scope c ON c.id=r.conversation_id
    WHERE a.owner_id=@owner AND a.state='pending' AND a.expires_at>@now`))
    add(a.project, {
      key: `approval:${a.id}`,
      kind: "approve",
      ref: a.id,
      conversation: a.conversation,
      message: a.message,
      at: a.at,
    });
  for (const d of read<{
    id: string;
    conversation: string;
    project: string;
    at: number;
    request: string;
  }>(`${scope}
    SELECT d.id,c.id conversation,c.status_project project,d.created_at at,d.request
    FROM native_decisions d JOIN scope c ON c.id=d.conversation_id
    JOIN runs r ON r.id=d.run_id AND r.owner_id=c.owner_id AND r.conversation_id=c.id
    JOIN companion_sessions s ON s.conversation_id=c.id AND s.generation=d.generation
    WHERE d.state='pending'`)) {
    let question = false;
    try {
      const q = JSON.parse(d.request).questions;
      question = Array.isArray(q) && q.length > 0;
    } catch {}
    add(d.project, {
      key: `decision:${d.id}`,
      kind: question ? "answer" : "approve",
      ref: d.id,
      conversation: d.conversation,
      message: null,
      at: d.at,
    });
  }
  for (const t of threads)
    if (
      t.needs &&
      t.feed_run_id &&
      !projects
        .get(t.status_project)
        ?.actions.some((a) => a.conversation === t.id)
    ) {
      add(t.status_project, {
        key: `run:${t.feed_run_id}`,
        ref: t.feed_run_id,
        kind: ["failed", "interrupted"].includes(t.feed_run_state ?? "")
          ? "failed"
          : "resume",
        conversation: t.id,
        message: null,
        at: t.feed_last_activity_at,
      });
    }
  for (const s of read<{
    id: string;
    project: string;
    conversation: string | null;
    at: number;
  }>(`
    SELECT s.id,f.project_id project,s.conversation_id conversation,s.created_at at
    FROM scheduled_sends s JOIN agents a ON a.id=s.agent_id AND a.owner_id=s.owner_id
    LEFT JOIN conversations c ON c.id=s.conversation_id AND c.owner_id=s.owner_id
    JOIN project_change_folders f ON f.owner_id=s.owner_id AND f.folder_id=COALESCE(s.folder_id,
      CASE WHEN s.conversation_id IS NOT NULL THEN c.feed_folder_id WHEN s.folder_chosen=0 THEN a.folder_id END)
    WHERE s.owner_id=@owner AND s.state='failed' AND (@project IS NULL OR f.project_id=@project)
      AND (@teams='null' OR c.team_id IN (SELECT value FROM json_each(@teams)))`)) {
    const p = projects.get(s.project);
    if (p) p.last_activity_at = Math.max(p.last_activity_at, s.at);
    add(s.project, {
      key: `send:${s.id}`,
      kind: "not_sent",
      ref: s.id,
      conversation: s.conversation,
      message: null,
      at: s.at,
    });
  }
  // Watches have no durable run foreign key. Keep them explicitly separate
  // from the named run; never join merely by latest time or shared conversation.
  type Watch = WatchRow & {
    id: string;
    conversation_id: string;
    project: string;
    login: string | null;
    created_at: number;
  };
  const watches = read<Watch>(`SELECT w.*,f.project_id project FROM pr_watches w
    JOIN conversations c ON c.id=w.conversation_id AND c.owner_id=w.owner_id
    JOIN project_change_folders f ON f.owner_id=w.owner_id AND f.folder_id=COALESCE(c.project_id,
      (SELECT p.project_id FROM project_changes p WHERE p.owner_id=w.owner_id AND p.kind='pr_update'
        AND substr(p.ref,1,length(w.id)+1)=w.id||':' ORDER BY p.seq DESC LIMIT 1),
      (SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=w.owner_id
        AND r.conversation_id=w.conversation_id AND r.created_at<=w.created_at ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1))
    WHERE w.owner_id=@owner AND (@project IS NULL OR f.project_id=@project)
      AND (@teams='null' OR c.team_id IN (SELECT value FROM json_each(@teams)))
      AND (w.state IN ('watching','paused') OR w.updated_at>@now-604800000)
    ORDER BY w.created_at,w.id`);
  const cards = read<{
    project_id: string;
    content: string;
    updated_at: number;
  }>(`
    SELECT s.project_id,a.content,a.updated_at FROM artifacts a JOIN project_change_sources s
      ON s.source='artifact' AND s.ref=a.id AND s.owner_id=a.owner_id
    JOIN artifact_publications pub ON pub.artifact_id=a.id
    WHERE a.owner_id=@owner AND a.kind='github_pr' AND a.archived=0
      AND (@project IS NULL OR s.project_id=@project) ORDER BY a.updated_at DESC,a.id`);
  for (const w of watches) {
    const p = projects.get(w.project);
    if (!p) continue;
    p.last_activity_at = Math.max(p.last_activity_at, w.created_at);
    p.pulls.push({
      id: w.id,
      conversation: w.conversation_id,
      state: pullStateFromWatch(w),
    });
    for (const a of cards) {
      if (a.project_id !== w.project) continue;
      let card: PullRequestCard;
      try {
        card = JSON.parse(a.content);
      } catch {
        continue;
      }
      if (card?.type !== "github_pull_requests" || !Array.isArray(card.pulls))
        continue;
      const pr = card.pulls.find(
        (p) =>
          p?.number === w.number &&
          typeof p.owner === "string" &&
          typeof p.repo === "string" &&
          p.owner.toLowerCase() === w.repo_owner.toLowerCase() &&
          p.repo.toLowerCase() === w.repo_name.toLowerCase(),
      );
      if (!pr) continue;
      if (
        !w.ended_reason &&
        w.state !== "stopped" &&
        w.login &&
        pr.state === "open" &&
        (!w.head_sha || pr.headSha === w.head_sha) &&
        Array.isArray(pr.reviewers) &&
        pr.reviewers.some(
          (login) =>
            typeof login === "string" &&
            login.toLowerCase() === w.login!.toLowerCase(),
        )
      ) {
        // Several watches of the same PR still represent one review request.
        add(w.project, {
          key: `review:${w.repo_owner.toLowerCase()}/${w.repo_name.toLowerCase()}/${w.number}`,
          kind: "review",
          ref: w.id,
          conversation: w.conversation_id,
          message: null,
          at: a.updated_at,
        });
      }
      break;
    }
  }
  type EvidenceRow = {
    project: string;
    id: string;
    conversation_id: string;
    name: string;
    input: string;
    summary: string | null;
    checkout_at: number | null;
    verification_at: number | null;
    output_at: number | null;
  };
  const evidence = read<EvidenceRow>(`WITH ver AS (
      SELECT run_id,max(observed_at) at FROM run_verifications WHERE owner_id=@owner GROUP BY run_id
    ), outputs AS (
      SELECT run_id,max(updated_at) at FROM agent_activities WHERE owner_id=@owner AND kind='output'
        AND json_extract(record,'$.data.command') IS NOT NULL AND COALESCE(json_extract(record,'$.data.unavailable'),0)=0 GROUP BY run_id
    ), ranked AS (
      SELECT f.project_id project,r.id,r.conversation_id,a.name,r.input,k.summary,
        COALESCE(k.ended_at,k.started_at) checkout_at,v.at verification_at,o.at output_at,
        row_number() OVER (PARTITION BY f.project_id ORDER BY (k.run_id IS NOT NULL OR v.run_id IS NOT NULL) DESC,
          COALESCE(k.ended_at,k.started_at,v.at,r.created_at) DESC,r.id) position
      FROM runs r JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
      JOIN agents a ON a.id=r.agent_id AND a.owner_id=r.owner_id
      JOIN project_change_folders f ON f.owner_id=r.owner_id AND f.folder_id=COALESCE(c.project_id,json_extract(r.payload,'$.folderId'))
      LEFT JOIN run_checkouts k ON k.run_id=r.id AND k.owner_id=r.owner_id
      LEFT JOIN ver v ON v.run_id=r.id LEFT JOIN outputs o ON o.run_id=r.id
      WHERE r.owner_id=@owner AND (@project IS NULL OR f.project_id=@project)
        AND (@teams='null' OR c.team_id IN (SELECT value FROM json_each(@teams)))
    ) SELECT * FROM ranked WHERE position=1`);
  const runIds = new Set(evidence.map((r) => r.id));
  const verifications = new Map<string, VerificationItem[]>();
  for (const row of read<
    Omit<VerificationItem, "tools"> & { run_id: string; tools: string }
  >(
    `
    SELECT id,run_id,kind,tools,command,status,exit_code,truncated,observed_at FROM run_verifications
    WHERE owner_id=@owner AND run_id IN (SELECT value FROM json_each(@runIds)) ORDER BY observed_at,id`,
    { runIds: JSON.stringify([...runIds]) },
  )) {
    const items = verifications.get(row.run_id) ?? [];
    items.push({
      ...row,
      tools: JSON.parse(row.tools),
      truncated: !!row.truncated,
    });
    verifications.set(row.run_id, items);
  }
  for (const r of evidence) {
    const p = projects.get(r.project);
    if (!p) continue;
    const items = verifications.get(r.id);
    p.evidence = {
      run_id: r.id,
      conversation: r.conversation_id,
      agent: r.name,
      task: r.input.slice(0, 240),
      checkout: r.summary ? JSON.parse(r.summary) : null,
      checkout_at: r.checkout_at,
      verification: items?.length ? summarize(items) : null,
      verification_at: r.verification_at ?? r.output_at,
      telemetry:
        items?.length || r.output_at !== null ? "observed" : "unavailable",
    };
  }
  for (const p of projects.values()) {
    p.actions.sort(
      (a, b) =>
        priority[a.kind] - priority[b.kind] ||
        a.at - b.at ||
        a.key.localeCompare(b.key),
    );
    p.counts.needs = p.actions.length;
    // A recorded blocker remains visible alongside progressing work.
    p.status = p.counts.needs
      ? "needs_you"
      : p.counts.working
        ? "working"
        : p.brief.blockers
          ? "blocked"
          : p.counts.queued
            ? "queued"
            : "idle";
    p.older =
      p.status === "idle" &&
      p.brief.blockers === 0 &&
      p.brief.state === "ready" &&
      at - p.last_activity_at > month;
    const severity = (state: ProjectStatus["pulls"][number]["state"]) => {
      return state.watch === "stopped"
        ? 4
        : state.ci?.conclusion === "failure"
          ? 0
          : state.error || state.watch === "paused"
            ? 1
            : state.pending
              ? 2
              : 3;
    };
    p.pulls.sort(
      (a, b) =>
        severity(a.state) - severity(b.state) ||
        (b.state.checked_at ?? 0) - (a.state.checked_at ?? 0) ||
        a.id.localeCompare(b.id),
    );
  }
  return {
    owner_id: owner,
    observed_at: at,
    teams,
    items: [...projects.values()].sort(compareProjectStatus),
  };
}

/** Opening re-resolves exactly the selected item, never its new replacement. */
export function projectStatusAction(
  owner: string,
  project: string,
  key: string,
  teams: string[] = [],
) {
  const page = projectStatuses(owner, { project, teams });
  const action = page.items[0]?.actions.find((a) => a.key === key);
  if (!action)
    throw new Problem(409, "This item no longer needs you. Refresh Status.");
  return action;
}
