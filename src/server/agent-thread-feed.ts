import { encodeCursor as encode, decodeCursor as decode } from "./cursors.js";
import * as agentMailQueries from "./sql/agent-mail.js";
import * as agentThreadsQueries from "./sql/agent-threads.js";
import * as artifactsQueries from "./sql/artifacts.js";
import * as mailQueries from "./sql/agent-mail.js";
import * as messagesQueries from "./sql/messages.js";
import { z } from "zod";
import { db } from "./db.js";
import { ownedAgent, ownedFolder, Problem } from "./domain.js";
import { projectFolders } from "./results.js";
import { teamFilter } from "./teams.js";
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
  const latest = mailQueries.ownedLatestInThread(db, owner, thread.id) as Mail;
  return {
    id: thread.id,
    subject: thread.subject,
    scope: thread.scope,
    paused_at: thread.paused_at,
    paused_reason: thread.paused_reason,
    updated_at: latest.created_at,
    message_count: (
      mailQueries.ownedThreadCount(db, owner, thread.id) as { n: number }
    ).n,
    participants: (
      agentMailQueries.participants(db, { owner, thread: thread.id }) as {
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
      ? decode(query.before, listCursor, "Invalid agent threads cursor")
      : null;
    const rows = agentThreadsQueries.feed(db, {
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
    const thread = agentThreadsQueries.visibleOwned(db, owner, id) as
      Thread | undefined;
    if (!thread) throw new Problem(404, "Thread not found");
    const cursor = query.before
      ? decode(query.before, messageCursor, "Invalid agent messages cursor")
      : null;
    const rows = mailQueries.ownedThreadPage(
      db,
      owner,
      id,
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
            messagesQueries.mailMessageId(
              db,
              owner,
              mail.recipient_conversation_id,
              mail.run_id,
              mail.requeued_run_id,
              mail.id,
            ) as { id: string } | undefined
          )?.id ?? null,
        attachments: artifactsQueries.mailFiles(db, owner, mail.file_ids) as {
          id: string;
          name: string;
        }[],
      })),
    };
  })();
}
