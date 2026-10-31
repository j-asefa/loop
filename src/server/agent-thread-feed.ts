import { z } from "zod";
import { db } from "./db.js";
import { ownedAgent, ownedFolder, Problem } from "./domain.js";
import { projectFolders } from "./results.js";
import { teamFilter } from "./teams.js";
import { encode, decode } from "./mobile-return/shared.js";
import {
  publicMailMessage,
  publicMailAgentReference,
  type Mail,
} from "./agent-mail.js";
import type {
  AgentThreadQuery,
  AgentThreadMessagesQuery,
  AgentThreadSummary,
} from "../shared/agent-thread-feed.js";

type Thread = {
  id: string;
  subject: string;
  scope: "direct" | "team";
  paused_at: number | null;
  paused_reason: string | null;
};
const listCursor = z.tuple([
  z.number().int().nonnegative(),
  z.string().min(1).max(200),
]);
const messageCursor = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().positive(),
]);
function summary(owner: string, thread: Thread): AgentThreadSummary {
  const latest = db
    .prepare(
      "SELECT * FROM agent_mail WHERE owner_id=? AND thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
    )
    .get(owner, thread.id) as Mail;
  return {
    id: thread.id,
    subject: thread.subject,
    scope: thread.scope,
    paused_at: thread.paused_at,
    paused_reason: thread.paused_reason,
    updated_at: latest.created_at,
    message_count: (
      db
        .prepare(
          "SELECT count(*) n FROM agent_mail WHERE owner_id=? AND thread_id=?",
        )
        .get(owner, thread.id) as { n: number }
    ).n,
    participants: (
      db
        .prepare(
          `WITH participants AS (
          SELECT sender_agent_id id FROM agent_mail WHERE owner_id=@owner AND thread_id=@thread
          UNION SELECT recipient_agent_id FROM agent_mail WHERE owner_id=@owner AND thread_id=@thread
        ) SELECT p.id,a.name FROM participants p
        LEFT JOIN agents a ON a.id=p.id AND a.owner_id=@owner
        WHERE a.id IS NOT NULL OR EXISTS (
          SELECT 1 FROM fleet_mail_threads f WHERE f.owner_id=@owner AND f.thread_id=@thread
          AND p.id='peer:'||f.peer_id||':'||f.remote_agent_id
        ) ORDER BY a.name,p.id`,
        )
        .all({ owner, thread: thread.id }) as {
        id: string;
        name: string | null;
      }[]
    ).map((person) => {
      const reference = publicMailAgentReference(owner, thread.id, person.id);
      return {
        id: person.id,
        name: reference.name ?? person.name ?? "former agent",
        ...(reference.kind === "peer" ? { reference } : {}),
      };
    }),
    latest: publicMailMessage(latest),
  };
}

/** Membership is exclusively agent_mail.thread_id. Conversation/run IDs only
 * scope the view or provide navigation; they never expand its message set. */
export function listAgentThreads(
  owner: string,
  query: z.infer<typeof AgentThreadQuery>,
) {
  return db.transaction(() => {
    if (query.agent) ownedAgent(query.agent, owner);
    if (query.project) ownedFolder(query.project, owner);
    const folders = query.project ? projectFolders(owner, query.project) : null;
    const teams = teamFilter(query.teams, owner);
    const cursor = query.before
      ? decode(query.before, listCursor, "agent threads")
      : null;
    const rows = db
      .prepare(
        `
      SELECT t.*,max(m.created_at) activity_at FROM agent_threads t
      JOIN agent_mail m ON m.owner_id=t.owner_id AND m.thread_id=t.id
      WHERE t.owner_id=@owner
        AND (@view='threads' OR EXISTS(SELECT 1 FROM agent_mail sent WHERE sent.owner_id=@owner AND sent.thread_id=t.id AND sent.state='sent'))
        AND EXISTS (
          SELECT 1 FROM agent_mail linked
          LEFT JOIN conversations c ON c.owner_id=linked.owner_id AND c.id IN (linked.sender_conversation_id,linked.recipient_conversation_id)
          LEFT JOIN runs r ON r.owner_id=linked.owner_id AND r.id IN (
            CASE WHEN c.id=linked.sender_conversation_id THEN linked.sender_run_id END,
            CASE WHEN c.id=linked.recipient_conversation_id THEN COALESCE(linked.requeued_run_id,linked.run_id) END
          )
          LEFT JOIN teams team ON team.owner_id=linked.owner_id AND team.deleted_at IS NULL
            AND team.id=CASE WHEN t.scope='team' THEN t.team_id ELSE c.team_id END
          WHERE linked.owner_id=@owner AND linked.thread_id=t.id
            AND (@agent IS NULL OR @agent IN (linked.sender_agent_id,linked.recipient_agent_id))
            AND (@teams IS NULL OR team.id IN (SELECT value FROM json_each(@teams)))
            AND (@agent IS NOT NULL OR @teams IS NOT NULL OR NOT COALESCE(team.hide_results_from_feed,0))
            AND (@folders IS NULL OR EXISTS (
              SELECT 1 FROM json_each(@folders) folder WHERE
                c.id IS NOT NULL AND folder.value IS CASE WHEN json_type(r.payload,'$.folderId') IS NOT NULL THEN json_extract(r.payload,'$.folderId') ELSE c.project_id END
            ))
        )
      GROUP BY t.id
      HAVING @at IS NULL OR (activity_at,t.id)<(@at,@id)
      ORDER BY activity_at DESC,t.id DESC LIMIT @limit
    `,
      )
      .all({
        owner,
        agent: query.agent ?? null,
        teams: teams.length ? JSON.stringify(teams) : null,
        folders: folders ? JSON.stringify(folders) : null,
        view: query.view,
        at: cursor?.[0] ?? null,
        id: cursor?.[1] ?? null,
        limit: query.limit + 1,
      }) as (Thread & { activity_at: number })[];
    const more = rows.length > query.limit;
    if (more) rows.pop();
    const last = rows.at(-1);
    return {
      items: rows.map((thread) => summary(owner, thread)),
      next: more && last ? encode([last.activity_at, last.id]) : null,
    };
  })();
}

export function readAgentThread(
  owner: string,
  id: string,
  query: z.infer<typeof AgentThreadMessagesQuery>,
) {
  return db.transaction(() => {
    const thread = db
      .prepare(
        "SELECT * FROM agent_threads WHERE owner_id=? AND id=? AND EXISTS(SELECT 1 FROM agent_mail WHERE owner_id=? AND thread_id=?)",
      )
      .get(owner, id, owner, id) as Thread | undefined;
    if (!thread) throw new Problem(404, "Thread not found");
    const cursor = query.before
      ? decode(query.before, messageCursor, "agent messages")
      : null;
    const rows = db
      .prepare(
        "SELECT *,rowid ordinal FROM agent_mail WHERE owner_id=? AND thread_id=? AND (? IS NULL OR (created_at,rowid)<(?,?)) ORDER BY created_at DESC,rowid DESC LIMIT ?",
      )
      .all(
        owner,
        id,
        cursor?.[0] ?? null,
        cursor?.[0] ?? null,
        cursor?.[1] ?? null,
        query.limit + 1,
      ) as (Mail & { ordinal: number })[];
    const more = rows.length > query.limit;
    if (more) rows.pop();
    const oldest = rows.at(-1);
    return {
      thread: summary(owner, thread),
      next: more && oldest ? encode([oldest.created_at, oldest.ordinal]) : null,
      messages: rows.reverse().map((mail) => ({
        ...publicMailMessage(mail),
        content: mail.body,
        message_id:
          (
            db
              .prepare(
                "SELECT id FROM messages WHERE owner_id=? AND conversation_id=? AND run_id IN (?,?) AND json_extract(metadata,'$.automation.mailId')=? ORDER BY created_at,id LIMIT 1",
              )
              .get(
                owner,
                mail.recipient_conversation_id,
                mail.run_id,
                mail.requeued_run_id,
                mail.id,
              ) as { id: string } | undefined
          )?.id ?? null,
        attachments: db
          .prepare(
            "SELECT id,title name FROM artifacts WHERE owner_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY id",
          )
          .all(owner, mail.file_ids) as { id: string; name: string }[],
      })),
    };
  })();
}
