import { db } from "../db.js";
import { briefAttention, listScheduledSends } from "../mobile-return.js";
import type { PullRequestCard } from "../../shared/github.js";
import { Brief, synthesisKinds, type Change } from "./schema.js";
import {
  active,
  assertProject,
  conversationProject,
  ledger,
  publicItem,
  readState,
  selectView,
  watchProject,
  type View,
} from "./store.js";

export function serveBrief(owner: string, project: string): Brief {
  return db.transaction(() => buildBrief(owner, project)).deferred();
}

function buildBrief(owner: string, project: string): Brief {
  assertProject(owner, project);
  const state = readState(owner, project),
    items = ledger(owner, project);
  const version = db
    .prepare(
      "SELECT * FROM project_briefs WHERE owner_id=? AND project_id=? AND version=? AND state='published'",
    )
    .get(owner, project, state.current_version) as
    | {
        view: string;
        basis_since: number;
        synth_at: number;
        unincorporated_before: number | null;
      }
    | undefined;
  const view: View = version
    ? JSON.parse(version.view)
    : selectView(items, null);
  const byId = new Map(items.map((r) => [r.id, publicItem(r)]));
  const selected = (
    key: "state" | "decisions" | "open_questions" | "unfinished",
  ) => view[key].flatMap((id) => byId.get(id) ?? []);
  const ack = Math.min(
    state.current_version,
    (
      db
        .prepare(
          "SELECT version FROM brief_acks WHERE owner_id=? AND project_id=?",
        )
        .get(owner, project) as { version: number } | undefined
    )?.version ?? 0,
  );
  const changes = new Map<string, Change>();
  const versions = db
    .prepare(
      "SELECT version,view FROM project_briefs WHERE owner_id=? AND project_id=? AND state='published' AND version>? AND version<=? ORDER BY version",
    )
    .all(owner, project, ack, state.current_version) as {
    version: number;
    view: string;
  }[];
  for (const row of versions)
    for (const change of (JSON.parse(row.view) as View).changes ?? []) {
      const key = change.field + ":" + change.id,
        prior = changes.get(key);
      changes.set(key, {
        ...change,
        since_version: prior?.since_version ?? change.since_version,
        pinned: change.pinned || !!prior?.pinned,
      });
    }
  const attention = briefAttention(owner, project);
  const needs: Brief["needs_you"] = [...attention.needs];
  // Not-sent messages live in scheduled_sends, not later_items. Read the same
  // paginated projection as the Feed and keep only this project's failures.
  let cursor: string | undefined;
  do {
    const page = listScheduledSends(owner, undefined, cursor);
    for (const send of page.items)
      if (send.state === "failed") {
        const folder =
          send.folder_id ??
          (!send.folder_chosen && !send.conversation_id
            ? (
                db
                  .prepare(
                    "SELECT folder_id FROM agents WHERE id=? AND owner_id=?",
                  )
                  .get(send.agent_id, owner) as
                  { folder_id: string | null } | undefined
              )?.folder_id
            : null);
        const scope = folder
          ? (
              db
                .prepare(
                  "SELECT project_id FROM project_change_folders WHERE owner_id=? AND folder_id=?",
                )
                .get(owner, folder) as { project_id: string } | undefined
            )?.project_id
          : send.conversation_id
            ? conversationProject(owner, send.conversation_id)
            : null;
        if (scope === project)
          needs.push({
            kind: "not_sent",
            ref: send.id,
            conversation: send.conversation_id ?? "",
          });
      }
    cursor = page.failed_next ?? undefined;
  } while (cursor);
  const artifacts: Brief["artifacts"] = [];
  const files = db
    .prepare(
      `SELECT a.id,a.kind,a.content,a.updated_at FROM artifacts a JOIN project_change_sources s ON s.source='artifact' AND s.ref=a.id
    JOIN artifact_publications p ON p.artifact_id=a.id WHERE a.owner_id=? AND s.project_id=? AND a.archived=0 ORDER BY a.updated_at DESC,a.id`,
    )
    .all(owner, project) as {
    id: string;
    kind: string;
    content: string;
    updated_at: number;
  }[];
  const watches = db
    .prepare(
      "SELECT * FROM pr_watches WHERE owner_id=? ORDER BY updated_at DESC,id",
    )
    .all(owner) as {
    id: string;
    conversation_id: string;
    number: number;
    repo_owner: string;
    repo_name: string;
    state: string;
    ended_reason: string | null;
    login: string | null;
    head_sha: string | null;
  }[];
  for (const w of watches) {
    if (watchProject(owner, w.id) !== project) continue;
    artifacts.push({
      kind: "pr",
      ref: w.id,
      state: w.ended_reason?.toLowerCase() ?? w.state,
    });
    // The most recent stored PR card records requested reviewers. Do not infer
    // an owner review merely from an open watch, and do not fetch GitHub here.
    for (const a of files.filter((f) => f.kind === "github_pr")) {
      let card: PullRequestCard;
      try {
        card = JSON.parse(a.content);
      } catch {
        continue;
      }
      if (
        !card ||
        card.type !== "github_pull_requests" ||
        !Array.isArray(card.pulls)
      )
        continue;
      const pr = card.pulls.find(
        (p) =>
          p &&
          typeof p.owner === "string" &&
          typeof p.repo === "string" &&
          p.number === w.number &&
          p.owner.toLowerCase() === w.repo_owner.toLowerCase() &&
          p.repo.toLowerCase() === w.repo_name.toLowerCase(),
      );
      if (!pr) continue;
      if (
        !w.ended_reason &&
        w.login &&
        pr.state === "open" &&
        (!w.head_sha || pr.headSha === w.head_sha) &&
        Array.isArray(pr.reviewers) &&
        pr.reviewers.some(
          (login) =>
            typeof login === "string" &&
            login.toLowerCase() === w.login!.toLowerCase(),
        )
      )
        needs.push({
          kind: "review",
          ref: w.id,
          conversation: w.conversation_id,
        });
      break;
    }
  }
  for (const a of files)
    if (a.kind !== "github_pr")
      artifacts.push({
        kind: a.kind === "chart" ? "chart" : "file",
        ref: a.id,
        state: "published",
      });
  const unfinished = items.filter((i) => i.kind === "unfinished" && active(i));
  const blocked =
    unfinished.length > 0 && unfinished.every((i) => !!i.blocker?.trim());
  const pending = (
    db
      .prepare(
        `SELECT count(*) n FROM project_changes WHERE owner_id=? AND project_id=? AND seq>? AND kind IN (SELECT value FROM json_each(?))`,
      )
      .get(
        owner,
        project,
        state.basis_through,
        JSON.stringify(synthesisKinds),
      ) as { n: number }
  ).n;
  return Brief.parse({
    format: "loop.brief/v1",
    project,
    version: state.current_version,
    basis: {
      since: version?.basis_since ?? 0,
      through: state.basis_through,
      synth_at: version?.synth_at ?? null,
      pending,
      unincorporated_before: version?.unincorporated_before ?? null,
      window: version
        ? `Recorded work as of ${new Date(version.synth_at).toISOString()}`
        : "Not generated yet",
    },
    status: needs.length
      ? "needs_you"
      : blocked
        ? "blocked"
        : attention.working
          ? "working"
          : "idle",
    goal: state.goal === null ? null : { text: state.goal },
    headline: view.headline,
    state: selected("state"),
    decisions: selected("decisions"),
    open_questions: selected("open_questions"),
    unfinished: selected("unfinished"),
    needs_you: needs,
    artifacts,
    changes: [...changes.values()],
    overflow: selectView(items, view.headline).overflow,
    pins: items.filter((i) => i.pinned).map((i) => i.id),
    acknowledged_version: ack,
  });
}
