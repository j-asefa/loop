import { checkoutContent, checkoutDetail } from "../run-checkouts.js";
import { verificationLines } from "../run-verifications.js";
import { db } from "../db.js";
import { resolveCite } from "./cites.js";
import { synthesisKinds, type Cite, type Item } from "./schema.js";
import { active, ledger, selectView, type State, type View } from "./store.js";

export const MAX_RESULTS = 40;
export const MAX_EVENT_BYTES = 200_000;
// Include the heading and cut marker in the rendered event budget.
const EVENT_CONTENT_BYTES = MAX_EVENT_BYTES - 512;
const kinds = JSON.stringify(synthesisKinds);
type Event = {
  seq: number;
  kind: string;
  ref: string;
  conversation_id: string | null;
  at: number;
};
export type BriefInput = {
  prompt: string;
  basisThrough: number;
  basisSince: number;
  unincorporatedBefore: number | null;
  cut: boolean;
  eventCount: number;
  eventBytes: number;
};
const quoted = (text: string) =>
  text
    .split("\n")
    .map((line) => "  " + line)
    .join("\n");
const oneLine = (text: string) => text.replace(/[\r\n]/g, " ");
const refs = (cites: Cite[]) => cites.map((c) => c.ref).join(", ");
function utf8Prefix(text: string, bytes: number) {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

/** All citable text comes from the same resolver used by publication. */
function eventText(owner: string, project: string, event: Event): string {
  const thread = event.conversation_id
    ? (db
        .prepare("SELECT title FROM conversations WHERE owner_id=? AND id=?")
        .get(owner, event.conversation_id) as { title: string } | undefined)
    : undefined;
  const time = new Date(event.at).toISOString(),
    location = `in thread "${oneLine(thread?.title ?? "untitled")}" (${event.conversation_id ?? "none"})`;
  let ref: string | undefined,
    description = event.kind;
  if (event.kind === "result") {
    ref = "res_" + event.ref;
    const source = resolveCite(owner, project, { ref });
    if (source) {
      const content =
        source.content.length > 4000
          ? source.content.slice(0, 4000).replace(/[\uD800-\uDBFF]$/, "") +
            "\n... (truncated)"
          : source.content;
      // The checkout Loop observed for the run that produced this result is
      // its own citable record: what changed in the repository, as seen by
      // Loop rather than described by the agent.
      const checkout = source.runId ? checkoutDetail(owner, source.runId) : null;
      // Only an ended capture: a record still in progress would change
      // under the citation.
      // The record's own text, caveats included (changes present before the
      // run, other runs on the checkout, a late capture, filtered files),
      // bounded, so the generator can qualify what the run itself did.
      const observed = checkout?.summary && checkout.ended_at
        ? `\n  Checkout [chk_${checkout.id}] observed by Loop:\n${quoted(utf8Prefix(checkoutContent(checkout), 2000))}`
        : "";
      // Verification Loop observed during the run: each command and the exit
      // Loop saw, citable on its own. Nothing listed means none was observed.
      const verified = source.runId ? verificationLines(owner, source.runId) : "";
      const checks = verified
        ? `\n  Verification observed by Loop:\n${quoted(verified)}`
        : checkout?.ended_at
          ? "\n  Verification observed by Loop: none"
          : "";
      return `[${ref}] ${time} result by ${source.agent ?? "unknown"} ${location}:\n${quoted(content)}${observed}${checks}`;
    }
  } else if (event.kind === "prompt") {
    ref = "msg_" + event.ref;
    const source = resolveCite(owner, project, { ref });
    description =
      (source?.automated ? "agent/automated prompt" : "owner prompt") +
      " " +
      location;
  } else if (
    event.kind === "approval_resolved" ||
    event.kind === "decision_resolved"
  ) {
    ref = "approval_" + event.ref;
    const source = resolveCite(owner, project, { ref });
    const status = ["approved", "executing", "completed"].includes(
      source?.state ?? "",
    )
      ? "granted"
      : (source?.state ?? "unavailable");
    description = `${event.kind === "decision_resolved" ? "native decision" : "approval"} ${status} ${location}`;
  } else if (event.kind === "pr_update") {
    const match =
      /^(.+):(comment|review_comment|review|merged|closed|ci_failure|ci_success):([^:]+)$/.exec(
        event.ref,
      );
    const watch = match
      ? (db
          .prepare("SELECT number FROM pr_watches WHERE owner_id=? AND id=?")
          .get(owner, match[1]) as { number: number } | undefined)
      : undefined;
    if (match && watch) {
      ref = `pr_${watch.number}:c_${match[3]}`;
      description = `pull request #${watch.number} ${match[2].startsWith("ci_") ? "checks" : match[2]} by recorded participants`;
    }
  } else if (["saved", "unsaved", "label"].includes(event.kind)) {
    const artifact = db
      .prepare(
        "SELECT id,title,metadata FROM artifacts WHERE owner_id=? AND id=?",
      )
      .get(owner, event.ref) as
      { id: string; title: string; metadata: string } | undefined;
    const message = artifact
      ? (JSON.parse(artifact.metadata).messageId as string | undefined)
      : event.ref;
    const candidates = [
      ...(message ? ["saved_" + message, "msg_" + message] : []),
      ...(artifact ? ["res_" + artifact.id] : []),
    ];
    ref = candidates.find((ref) => resolveCite(owner, project, { ref }));
    const label = db
      .prepare("SELECT label FROM saved_labels WHERE owner_id=? AND item_key=?")
      .get(owner, (artifact ? "a:" : "m:") + event.ref) as
      { label: string } | undefined;
    description = `owner ${event.kind === "label" ? "labeled" : event.kind} result "${oneLine(artifact?.title ?? "message")}" with label "${oneLine(label?.label ?? "none")}"`;
  } else if (event.kind === "mail") {
    const mail = db
      .prepare(
        "SELECT sender_agent_id,recipient_agent_id FROM agent_mail WHERE owner_id=? AND id=?",
      )
      .get(owner, event.ref) as
      { sender_agent_id: string; recipient_agent_id: string } | undefined;
    // Mail has no Cite variant: use the actual delivered message's supported
    // ref, preserving automation provenance rather than inventing owner text.
    const message = db
      .prepare(
        `SELECT m.id FROM messages m JOIN project_change_sources s ON s.source='message' AND s.ref=m.id
      WHERE m.owner_id=? AND s.project_id=? AND m.conversation_id=? AND m.role='user'
        AND json_extract(m.metadata,'$.automation.mailId')=? AND m.created_at<=?
      ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1`,
      )
      .get(owner, project, event.conversation_id, event.ref, event.at) as
      { id: string } | undefined;
    if (message && mail) {
      ref = "msg_" + message.id;
      description = `message from @${mail.sender_agent_id} to @${mail.recipient_agent_id} ${location} (mail ${event.ref})`;
    }
  } else if (event.kind === "brief_edit") {
    const item = ledger(owner, project).find((i) => i.id === event.ref);
    return `[brief_edit] ${time} owner edited ${event.ref}${item ? ": " + oneLine(item.text) : ""}; see current GOAL, PINNED and ledger above.`;
  }
  const source = ref ? resolveCite(owner, project, { ref }) : null;
  if (source)
    return `[${ref}] ${time} ${description}:\n${quoted(source.content)}`;
  return `[tombstone] ${time} record ${event.ref} ${event.kind === "tombstone" ? "was deleted" : "is unavailable for citation"} (${event.kind})`;
}

function previousLine(item: Item) {
  const context =
    item.kind === "decision"
      ? ` ${item.evidence ?? ""} by ${item.decided_by ?? "unknown"}`
      : item.kind === "question"
        ? ` asked by ${item.asked_by ?? "unknown"}`
        : item.kind === "unfinished"
          ? ` thread ${item.thread ?? "none"}`
          : "";
  const extra =
    item.kind === "decision"
      ? ` — ${item.why ?? ""}`
      : item.kind === "unfinished"
        ? ` · next: ${item.next ?? ""} · blocker: ${item.blocker ?? ""}`
        : "";
  return `  ${item.id} ${item.status}${context}: ${oneLine(item.text)}${oneLine(extra)} [${refs(item.cite)}]`;
}

/** Call within the job's capture transaction, before any provider IO. */
export function buildInput(state: State): BriefInput {
  const owner = state.owner_id,
    project = state.project_id;
  const items = ledger(owner, project);
  const version = db
    .prepare(
      "SELECT view,unincorporated_before FROM project_briefs WHERE owner_id=? AND project_id=? AND version=? AND state='published'",
    )
    .get(owner, project, state.current_version) as
    { view: string; unincorporated_before: number | null } | undefined;
  const view: View = version
    ? JSON.parse(version.view)
    : selectView(items, null);
  const byId = new Map(items.map((i) => [i.id, i]));
  const shown = new Set([
    ...view.state,
    ...view.decisions,
    ...view.open_questions,
    ...view.unfinished,
  ]);
  const previous = [
    `PREVIOUS BRIEF (version ${state.current_version})`,
    `headline: ${oneLine(view.headline?.text ?? "none")} [${refs(view.headline?.cite ?? [])}]`,
  ];
  for (const section of [
    "state",
    "decisions",
    "open_questions",
    "unfinished",
  ] as const) {
    previous.push(section + ":");
    for (const id of view[section]) {
      const item = byId.get(id);
      if (item) previous.push(previousLine(item));
    }
  }
  // Owner versions do not incorporate events. The first generation still
  // starts with recent history even if the owner has already recorded a choice.
  const initial = state.basis_through === 0;
  const params = { owner, project, kinds, through: state.basis_through };
  const recent =
    state.unincorporated_before ??
    version?.unincorporated_before ??
    (initial
      ? (
          db
            .prepare(
              `SELECT min(seq) first FROM (SELECT seq FROM project_changes
    WHERE owner_id=@owner AND project_id=@project AND kind='result' ORDER BY seq DESC LIMIT 40)`,
            )
            .get({ owner, project }) as { first: number | null }
        ).first
      : null);
  const filter =
    recent !== null && state.basis_through < recent
      ? "AND (kind='saved' OR seq>=@recent)"
      : "";
  const eventParams = { ...params, ...(filter ? { recent } : {}) };
  const rows = db
    .prepare(
      `SELECT seq,kind,ref,conversation_id,at FROM project_changes
    WHERE owner_id=@owner AND project_id=@project AND seq>@through AND kind IN (SELECT value FROM json_each(@kinds)) ${filter} ORDER BY seq`,
    )
    .iterate(eventParams) as IterableIterator<Event>;
  const events: string[] = [];
  let bytes = 0,
    results = 0,
    through = state.basis_through,
    since = state.basis_through;
  for (const row of rows) {
    let text = eventText(owner, project, row);
    const separator = events.length ? 2 : 0;
    if (Buffer.byteLength(text) + separator > EVENT_CONTENT_BYTES - bytes) {
      if (events.length) break;
      const suffix = "\n  ... (truncated)";
      text =
        utf8Prefix(text, EVENT_CONTENT_BYTES - Buffer.byteLength(suffix)) +
        suffix;
    }
    if (initial && !events.length) since = row.seq;
    events.push(text);
    bytes += Buffer.byteLength(text) + separator;
    through = row.seq;
    if (row.kind === "result") results++;
    if (results >= MAX_RESULTS || bytes >= EVENT_CONTENT_BYTES) break;
  }
  const remaining = (
    db
      .prepare(
        `SELECT count(*) n FROM project_changes WHERE owner_id=@owner AND project_id=@project
    AND seq>@through AND kind IN (SELECT value FROM json_each(@kinds)) ${filter}`,
      )
      .get({ ...eventParams, through }) as { n: number }
  ).n;
  const skipped =
    initial &&
    recent !== null &&
    !!db
      .prepare(
        `SELECT 1 FROM project_changes WHERE owner_id=@owner AND project_id=@project
    AND seq<@recent AND kind<>'saved' AND kind IN (SELECT value FROM json_each(@kinds)) LIMIT 1`,
      )
      .get({ owner, project, recent, kinds });
  const index = items
    .filter((i) => active(i) && !shown.has(i.id))
    .map(
      (i) =>
        `${i.id} ${i.kind} ${i.status}: ${oneLine(i.text.slice(0, 120))} [${refs(i.cite)}]`,
    );
  return {
    prompt: [
      `GOAL\n${state.goal ?? "none set"}`,
      `PINNED\n${items
        .filter((i) => i.pinned)
        .map((i) => `${i.id}: ${oneLine(i.text)} (${i.kind}, ${i.status})`)
        .join("\n")}`,
      previous.join("\n"),
      `INDEX (active items not shown above; reuse these ids if you update them)\n${index.join("\n")}`,
      `EVENTS (seq ${since} to ${through}, oldest first)\n${events.join("\n\n")}${remaining ? `\n\nEVENTS CUT: ${remaining} more events after seq ${through} will be sent in the next pass.` : ""}`,
    ].join("\n\n"),
    basisThrough: through,
    basisSince: since,
    unincorporatedBefore: skipped
      ? recent
      : (state.unincorporated_before ?? version?.unincorporated_before ?? null),
    cut: remaining > 0,
    eventCount: events.length,
    eventBytes: bytes,
  };
}
