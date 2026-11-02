import * as mailQueries from "./sql/agent-mail.js";
import type { MailStatus } from "../shared/agent-mail.js";
import { FleetGrantContext } from "../shared/fleet.js";
import {
  FleetMailEnvelope,
  parseFleetAgentAddress,
} from "../shared/fleet-mail.js";
import { db, now } from "./db.js";
import { Problem, ownedRun } from "./domain.js";
import {
  authorizeMail,
  eligibleMailAgent,
  fleetMailBindings,
  mailAuthority,
  mailConversation,
  MailRefusal,
} from "./agent-mail-policy.js";
import { directoryDigest, fleetPayloadDigest } from "./fleet-crypto.js";
import { FleetMailJournal } from "./fleet-mail-journal.js";
import { assertFleetMailTools } from "./fleet-mail-tools.js";
import { maybeConnection } from "./row-schemas.js";
import {
  assertFleetEffect,
  authorizeFleetEffect,
} from "./fleet-effect-authorizations.js";
import { currentFleetAction } from "./fleet-action-context.js";
import type { Run } from "./queue.js";
import {
  authorizeFleetMailFiles,
  captureFleetMailFiles,
  readFleetMailFile,
  MailFileRefusal,
} from "./agent-mail-files.js";

type OriginMail = {
  id: string;
  owner_id: string;
  thread_id: string;
  sender_agent_id: string;
  sender_run_id: string | null;
  sender_conversation_id: string | null;
  recipient_agent_id: string;
  recipient_conversation_id: string | null;
  body: string;
  file_ids: string;
  interrupt: number;
  state: string;
};
type Attribution = {
  connection_id: string;
  native_generation: string | null;
  native: number;
};
const refused = () =>
  new MailRefusal(409, "The original sending task is no longer authorized.");
export function fleetMailJournal(owner: string) {
  return new FleetMailJournal(db, mailAuthority(), owner);
}

/** Capture the executing run before a held or pending message can leave this
 * machine. The surrounding send transaction owns these writes. */
export function captureFleetMailSender(run: Run, mail: OriginMail) {
  assertFleetMailTools(run.owner_id);
  const reference = parseFleetAgentAddress(mail.recipient_agent_id);
  const sender = eligibleMailAgent(run.owner_id, run.agent_id!);
  const connection = maybeConnection(
    db
      .prepare("SELECT * FROM connections WHERE owner_id=? AND id=?")
      .get(run.owner_id, run.payload.connectionId ?? null),
  );
  if (!reference || !connection || sender.connection_id !== connection.id)
    throw refused();
  const native = !!connection.metadata.loop55Harness;
  const generation = native
    ? (db
        .prepare(
          `SELECT d.generation FROM native_dispatch d
        JOIN companion_sessions s ON s.conversation_id=? AND s.generation=d.generation AND s.state='running'
        WHERE d.run_id=? AND d.state IN ('unknown','accepted')`,
        )
        .get(run.conversation_id, run.id) as { generation: string } | undefined)
    : undefined;
  if (native && !generation) throw refused();
  db.prepare(
    `INSERT INTO fleet_mail_dispatch
      (mail_id,connection_id,native_generation,native) VALUES(?,?,?,?)`,
  ).run(mail.id, connection.id, generation?.generation ?? null, native ? 1 : 0);
  db.prepare(
    `INSERT INTO fleet_mail_records
      (mail_id,owner_id,peer_id,message_id,direction,sender_name) VALUES(?,?,?,?,'outgoing',?)`,
  ).run(mail.id, run.owner_id, reference.machineId, mail.id, sender.name);
}

function currentSender(mail: OriginMail) {
  if (!mail.sender_run_id || !mail.sender_conversation_id) throw refused();
  const sender = eligibleMailAgent(mail.owner_id, mail.sender_agent_id);
  mailConversation(mail.owner_id, sender.id, mail.sender_conversation_id);
  let run: Run;
  try {
    run = ownedRun(mail.sender_run_id, mail.owner_id);
    assertFleetEffect(mail.owner_id, "run", run.id);
    const release = db
      .prepare(
        "SELECT grant_context FROM fleet_mail_effects WHERE mail_id=? AND owner_id=?",
      )
      .get(mail.id, mail.owner_id) as { grant_context: string } | undefined;
    if (release)
      authorizeFleetEffect(
        mail.owner_id,
        FleetGrantContext.parse(JSON.parse(release.grant_context)),
      );
  } catch (error) {
    if (error instanceof Problem) throw refused();
    throw error;
  }
  const captured = db
    .prepare("SELECT * FROM fleet_mail_dispatch WHERE mail_id=?")
    .get(mail.id) as Attribution | undefined;
  if (
    !captured ||
    run.agent_id !== sender.id ||
    run.conversation_id !== mail.sender_conversation_id ||
    run.payload.connectionId !== captured.connection_id ||
    sender.connection_id !== captured.connection_id ||
    run.payload.reviewId ||
    run.payload.execution ||
    ["failed", "cancelled", "interrupted"].includes(run.state) ||
    !db
      .prepare("SELECT 1 FROM connections WHERE id=? AND owner_id=?")
      .get(captured.connection_id, mail.owner_id)
  )
    throw refused();
  if (captured.native) {
    const dispatch = db
      .prepare("SELECT generation,state FROM native_dispatch WHERE run_id=?")
      .get(run.id) as { generation: string; state: string } | undefined;
    if (
      !dispatch ||
      dispatch.generation !== captured.native_generation ||
      (run.state === "completed"
        ? dispatch.state !== "completed"
        : !["unknown", "accepted"].includes(dispatch.state))
    )
      throw refused();
    // A completed, durable intent survives an idle harness restart. While the
    // task is active, only its current native generation may send it.
    if (
      run.state !== "completed" &&
      !db
        .prepare(
          "SELECT 1 FROM companion_sessions WHERE conversation_id=? AND generation=? AND state='running'",
        )
        .get(run.conversation_id, captured.native_generation)
    )
      throw refused();
  }
  if (["pausing", "paused", "awaiting_approval"].includes(run.state))
    throw new Problem(
      409,
      "The sending task is paused. Its message remains pending.",
    );
  if (!["running", "completed"].includes(run.state)) throw refused();
  return run;
}

/** Called again inside the journal's last transaction before envelope IO.
 * Receipt-only recovery deliberately does not need an active sender. */
export function authorizeFleetMailSender(
  owner: string,
  envelope: FleetMailEnvelope,
) {
  const mail = mailQueries.outgoing(db, owner, envelope.messageId) as
    OriginMail | undefined;
  const authority = mailAuthority();
  if (
    !mail ||
    mail.state !== "pending" ||
    envelope.source.machineId !== authority.identity.machineId ||
    envelope.source.agentId !== mail.sender_agent_id ||
    envelope.sender.runId !== mail.sender_run_id ||
    envelope.sender.conversationId !== mail.sender_conversation_id
  )
    throw refused();
  const thread = db
    .prepare("SELECT * FROM agent_threads WHERE owner_id=? AND id=?")
    .get(owner, mail.thread_id) as
    | {
        id: string;
        owner_id: string;
        scope: "direct";
        team_id: null;
      }
    | undefined;
  if (!thread) throw refused();
  authorizeMail(thread, mail.sender_agent_id, mail.recipient_agent_id);
  // A pause holds new mail, not previously accepted/released pending work.
  // Resume can pause again on a later held item while this one still drains,
  // just as the local pending-mail sweeper does.
  const run = currentSender(mail);
  authorizeFleetMailFiles(run, envelope.files);
  if (envelope.files.length) {
    try {
      authority.acceptedGrant(
        owner,
        envelope.destination.machineId,
        envelope.authority.fleetId,
        envelope.authority.sourceGrantId,
        "files",
      );
    } catch (error) {
      if (error instanceof Problem && error.status === 403)
        throw new MailFileRefusal(
          409,
          "The original file-sharing grant is unavailable.",
        );
      throw error;
    }
  }
}

/** Durable local dispatch only. The owning gateway's drainer performs IO. */
export function enqueueFleetMail(mail: OriginMail, subject: string) {
  assertFleetMailTools(mail.owner_id);
  const journal = fleetMailJournal(mail.owner_id);
  if (journal.outgoing(mail.id)) return;
  const { binding, directory } = fleetMailBindings(mail.owner_id).authorize(
    mail.thread_id,
    mail.sender_agent_id,
    mail.recipient_agent_id,
  );
  const captured = db
    .prepare(
      "SELECT sender_name FROM fleet_mail_records WHERE mail_id=? AND direction='outgoing'",
    )
    .get(mail.id) as { sender_name: string } | undefined;
  if (!captured) throw refused();
  const files = captureFleetMailFiles(
    currentSender(mail),
    mailAuthority().identity.machineId,
    JSON.parse(mail.file_ids) as string[],
  );
  mailQueries.releaseOutgoing(db, mail.id);
  const envelope = FleetMailEnvelope.parse({
    version: 1,
    messageId: mail.id,
    source: {
      machineId: mailAuthority().identity.machineId,
      agentId: mail.sender_agent_id,
    },
    destination: {
      machineId: binding.peer_id,
      agentId: binding.remote_agent_id,
    },
    authority: {
      fleetId: binding.fleet_id,
      sourceGrantId: binding.local_grant_id,
      destinationGrantId: binding.peer_grant_id,
      directory: directoryDigest(directory),
    },
    sender: {
      name: captured.sender_name,
      runId: mail.sender_run_id,
      conversationId: mail.sender_conversation_id,
    },
    thread: {
      origin: binding.origin_id,
      id: binding.wire_thread_id,
      subject,
      recipientConversationId: mail.recipient_conversation_id,
    },
    body: mail.body,
    interrupt: mail.interrupt === 1,
    files,
  });
  const action = currentFleetAction();
  if (action) {
    if (!db.inTransaction || action.owner !== mail.owner_id) throw refused();
    authorizeFleetEffect(mail.owner_id, action.grant);
    db.prepare("INSERT INTO fleet_mail_effects VALUES(?,?,?,?)").run(
      mail.id,
      mail.owner_id,
      action.commandId,
      JSON.stringify(action.grant),
    );
  }
  journal.enqueue(envelope, (value) =>
    authorizeFleetMailSender(mail.owner_id, value),
  );
  mail.state = "pending";
}

/** Used only by the owning peer transport, never an agent-selected URL/path. */
export function outgoingFleetMailFile(
  owner: string,
  envelope: FleetMailEnvelope,
  fileId: string,
) {
  authorizeFleetMailSender(owner, envelope);
  const file = envelope.files.find((file) => file.fileId === fileId);
  const stored = fleetMailJournal(owner).outgoing(envelope.messageId);
  if (!file || !stored || stored.payloadDigest !== fleetPayloadDigest(envelope))
    throw new Problem(
      409,
      "The file does not belong to this outgoing message.",
    );
  const mail = mailQueries.owned(db, owner, envelope.messageId) as OriginMail;
  return readFleetMailFile(currentSender(mail), file);
}

export function fleetOutgoingStatus(mail: OriginMail): MailStatus | undefined {
  if (!parseFleetAgentAddress(mail.recipient_agent_id)) return;
  if (mail.state === "held") return "held";
  const stored = fleetMailJournal(mail.owner_id).outgoing(mail.id);
  if (stored?.state === "unknown") return "unconfirmed";
  if (stored?.state === "refused" || mail.state === "refused")
    return "not_delivered";
  const admission = stored?.receipt?.admission;
  return admission?.state === "accepted"
    ? admission.status
    : "transport_pending";
}

/** Project verified destination evidence without inventing a local run or
 * replacing the two participants' original conversation bindings. */
export function reconcileFleetMail(owner: string, messageId: string) {
  db.transaction(() => {
    const mail = mailQueries.outgoingProjection(db, owner, messageId);
    if (!mail) return;
    const stored = fleetMailJournal(owner).outgoing(messageId);
    if (!stored) return;
    const admission = stored.receipt?.admission;
    let changed = false;
    if (stored.state === "refused") {
      const error = `Remote mail refused: ${stored.localRefusal ?? (admission?.state === "refused" ? admission.reason : "unavailable")}.`;
      changed =
        mailQueries.projectRefused(db, error, owner, messageId, error).changes >
        0;
    } else if (admission?.state === "accepted") {
      changed =
        mailQueries.projectAccepted(
          db,
          admission.conversationId,
          now(),
          owner,
          messageId,
          admission.conversationId,
        ).changes > 0;
      // An interrupt's target belongs to that message, not an unresolved
      // ordinary thread default. The destination may later bind a different one.
      if (!mail.interrupt)
        db.prepare(
          `UPDATE agent_thread_members SET conversation_id=?
          WHERE thread_id=? AND agent_id=? AND conversation_id IS NULL AND ? IS NOT NULL`,
        ).run(
          admission.conversationId,
          mail.thread_id,
          mail.recipient_agent_id,
          admission.conversationId,
        );
    } else return;
    // An unchanged successful receipt may clear a transport error. Otherwise,
    // only a newly committed receipt should advance visible thread activity.
    if (!changed && !mail.projection_pending) return;
    db.prepare(
      "UPDATE fleet_mail_records SET projection_pending=0 WHERE owner_id=? AND mail_id=?",
    ).run(owner, messageId);
    // Multiple genuine receipt transitions in one clock tick still publish.
    db.prepare(
      "UPDATE agent_threads SET updated_at=max(updated_at+1,?) WHERE owner_id=? AND id=?",
    ).run(now(), owner, mail.thread_id);
  }).immediate();
}

/** Recover the receipt/projection commit gap, including settled outbox rows.
 * The partial index and batch limit keep idle passes and recovery bounded. */
export function recoverFleetMailProjections(owner: string) {
  const pending = db
    .prepare(
      `SELECT mail_id FROM fleet_mail_records
      WHERE owner_id=? AND projection_pending=1 AND direction='outgoing'
      ORDER BY mail_id LIMIT 100`,
    )
    .all(owner) as { mail_id: string }[];
  for (const { mail_id } of pending) reconcileFleetMail(owner, mail_id);
}
