import { cardAttachments } from "./card-attachments.js";
import { doneCards } from "./done-cards.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db, now } from "./db.js";
import { Problem, owned } from "./domain.js";
import { personalMessageSql } from "./personal-history.js";
import { runModelName } from "../shared/model-display.js";
import { artifactRefreshSource } from "../shared/artifact-refresh.js";
import {
  fileArtifactSql,
  projectFolders,
  resultOutputSql,
  resultUrl,
  resultsRevision,
} from "./results.js";
import { teamFilter } from "./teams.js";
import {
  CardChangesQuerySchema,
  CardIdSchema,
  CardListQuerySchema,
  type Card,
  type CardEntry,
  type CardSelection,
  type CardView,
} from "../shared/cards.js";

// Reuse fixed statement plans across cards; each lookup still reads the current
// owner-bound row so catalog edits, file deletion and revocation stay visible.
const modelConnection = db.prepare(
  "SELECT id,provider,models FROM connections WHERE owner_id=? AND id=?",
);
const ownedObject = db.prepare(
  "SELECT 1 FROM objects WHERE owner_id=? AND id=?",
);
const publishedFile = db.prepare(
  "SELECT 1 FROM artifact_objects WHERE owner_id=? AND artifact_id=?",
);

// One predicate per view, used by list, detail and delta projection. Saved is
// deliberately broader than Results: hidden pins and saved uploads still exist.
export const resultCardSql = `a.archived=0 AND a.feed_hidden=0 AND p.sequence IS NOT NULL AND COALESCE(json_extract(a.metadata,'$.snippet'),0) IN (0,'') AND ${resultOutputSql}`;
export const savedResultCardSql = `a.archived=0 AND a.pinned=1 AND b.sequence IS NOT NULL
  AND ${fileArtifactSql} AND json_extract(a.metadata,'$.snippet') IS NULL`;
export const savedMessageCardSql = `b.message_id IS NOT NULL`;

type Selection = CardSelection & {
  teamIds: string[];
  folders: (string | null)[] | null;
};
type Row = {
  id: string;
  owner_id: string;
  content: string;
  metadata: string;
  created_at: number;
  updated_at: number | null;
  title: string | null;
  kind: string | null;
  version: number | null;
  role: string | null;
  conversation_id: string | null;
  conversation_title: string | null;
  run_id: string | null;
  folder_id: string | null;
  project_id: string | null;
  project_name: string | null;
  team_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  provider: string | null;
  personal: number;
  saved: number;
  feed_hidden: number;
  order_at: number;
  key: string;
  saved_at: number | null;
  label: string | null;
};
const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
function decode(value: string): unknown {
  if (!/^[\w-]+$/.test(value)) throw new Error("Invalid encoding");
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}
function selection(owner: string, input: CardSelection): Selection {
  if (["results", "done"].includes(input.view) && input.q !== undefined)
    throw new Problem(400, "Search is supported for Saved and Sent");
  if (input.project) owned("folders", input.project, owner);
  if (input.agent) owned("agents", input.agent, owner);
  return {
    ...input,
    teamIds: teamFilter(input.teams, owner).sort(),
    folders: input.project ? projectFolders(owner, input.project) : null,
  };
}
function fingerprint(owner: string, options: Selection) {
  const { epoch } = db
    .prepare("SELECT epoch FROM card_revision_domain WHERE singleton=1")
    .get() as { epoch: string };
  return createHash("sha256")
    .update(
      JSON.stringify([
        epoch,
        owner,
        options.view,
        options.project || null,
        options.agent || null,
        options.teamIds,
        options.q || null,
      ]),
    )
    .digest("hex");
}
const revisionTuple = z.tuple([
  z.string(),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
]);
const orderTuple = z.tuple([
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.string().max(400),
]);
function readRevision(value: string, scope: string, current: number) {
  try {
    const [domain, revision] = revisionTuple.parse(decode(value));
    if (domain !== scope || revision > current)
      throw new Error("Different revision domain");
    return revision;
  } catch {
    throw new Problem(
      409,
      "Resynchronization required: reload this card selection",
    );
  }
}
function readBefore(
  value: string | undefined,
  scope: string,
): [number, string] | null {
  if (!value) return null;
  try {
    const [domain, order] = z
      .tuple([z.string(), orderTuple])
      .parse(decode(value));
    if (domain !== scope) throw new Error("Different selection");
    return order;
  } catch {
    throw new Problem(400, "Invalid card page cursor for this selection");
  }
}

// The canonical mapping gives nested projects their own identity and includes
// the Workspace's null/unfiled folders. Only ordinary folders inherit a project.
// SQLite lower() is ASCII-only. Normalize composed text and use the same
// Unicode lowercase operation for both the query and every searched field.
db.function("card_lower", { deterministic: true }, (value) =>
  typeof value === "string" ? value.normalize("NFC").toLowerCase() : null,
);

const projects = `WITH card_projects(folder_id,project_id) AS (
  SELECT folder_id,project_id FROM project_change_folders WHERE owner_id=@owner
)`;

function query(
  owner: string,
  options: Selection,
  type: "artifact" | "message",
  {
    ids,
    before,
    limit = 100,
  }: { ids?: string[]; before?: [number, string] | null; limit?: number } = {},
): Row[] {
  const artifact = type === "artifact";
  if (ids && !ids.length) return [];
  if (
    (artifact && options.view === "sent") ||
    (!artifact && options.view === "results")
  )
    return [];
  const folder = artifact
    ? "a.folder_id"
    : "COALESCE(json_extract(r.payload,'$.folderId'),c.project_id)";
  const agent = artifact
    ? "a.agent_id"
    : `CASE WHEN ${personalMessageSql} THEN r.agent_id ELSE COALESCE(r.agent_id,c.agent_id) END`;
  const filterAgent = artifact
    ? agent
    : `CASE WHEN ${personalMessageSql} THEN r.agent_id END`;
  const source = artifact ? "a" : "m";
  const key = `'${artifact ? "a" : "m"}:'||${source}.id`;
  const at =
    options.view === "saved"
      ? artifact
        ? "COALESCE(b.saved_at,a.updated_at)"
        : "b.created_at"
      : artifact
        ? "p.sequence"
        : "m.created_at";
  const predicate = artifact
    ? options.view === "saved"
      ? savedResultCardSql
      : resultCardSql
    : options.view === "saved"
      ? savedMessageCardSql
      : personalMessageSql;
  const search =
    options.view === "sent"
      ? "instr(card_lower(m.content),card_lower(@q))>0"
      : artifact
        ? "(instr(card_lower(a.content),card_lower(@q))>0 OR instr(card_lower(a.title),card_lower(@q))>0 OR instr(card_lower(l.label),card_lower(@q))>0)"
        : "(instr(card_lower(m.content),card_lower(@q))>0 OR instr(card_lower(c.title),card_lower(@q))>0 OR instr(card_lower(l.label),card_lower(@q))>0)";
  return db
    .prepare(
      `${projects}
    SELECT ${source}.id,${source}.owner_id,${source}.content,${source}.metadata,${source}.created_at,
      ${artifact ? "a.updated_at,a.title,a.kind,a.version,NULL role" : "NULL updated_at,NULL title,NULL kind,NULL version,m.role"},
      c.id conversation_id,c.title conversation_title,r.id run_id,${folder} folder_id,
      project.id project_id,project.name project_name,c.team_id,
      g.id agent_id,g.name agent_name,g.provider,
      ${
        artifact
          ? "0 personal,a.pinned saved,a.feed_hidden"
          : `COALESCE((${personalMessageSql}),0) personal,
        (b.message_id IS NOT NULL OR EXISTS(SELECT 1 FROM artifacts sa WHERE sa.owner_id=m.owner_id
          AND sa.conversation_id=m.conversation_id AND sa.pinned=1 AND sa.archived=0
          AND json_extract(sa.metadata,'$.messageId')=m.id)) saved,0 feed_hidden`
      },
      ${at} order_at,${key} key,
      ${artifact ? "CASE WHEN a.pinned=1 THEN COALESCE(b.saved_at,a.updated_at) END" : "b.created_at"} saved_at,l.label
    FROM ${artifact ? "artifacts a" : "messages m"}
    ${artifact ? "LEFT JOIN" : "JOIN"} conversations c ON c.id=${source}.conversation_id AND c.owner_id=${source}.owner_id
    LEFT JOIN runs r ON r.id=${source}.run_id AND r.owner_id=${source}.owner_id
    LEFT JOIN agents g ON g.id=(${agent}) AND g.owner_id=${source}.owner_id
    ${
      artifact
        ? "LEFT JOIN artifact_publications p ON p.artifact_id=a.id LEFT JOIN artifact_bookmarks b ON b.artifact_id=a.id"
        : "LEFT JOIN message_bookmarks b ON b.message_id=m.id AND b.owner_id=m.owner_id"
    }
    LEFT JOIN saved_labels l ON l.owner_id=${source}.owner_id AND l.item_key=${key}
    LEFT JOIN card_projects fp ON fp.folder_id IS ${folder}
    LEFT JOIN folders project ON project.id=fp.project_id AND project.owner_id=${source}.owner_id
    WHERE ${source}.owner_id=@owner AND (${source}.conversation_id IS NULL OR c.id IS NOT NULL)
      AND (${predicate})
      ${ids ? `AND ${source}.id IN (SELECT value FROM json_each(@ids))` : ""}
      AND (@folders IS NULL OR EXISTS(SELECT 1 FROM json_each(@folders) WHERE value IS ${folder}))
      AND (@agent IS NULL OR (${filterAgent})=@agent)
      AND (@teams IS NULL OR c.team_id IN (SELECT value FROM json_each(@teams)))
      AND (@q IS NULL OR ${search})
      AND (@at IS NULL OR (${at},${key})<(@at,@key))
    ORDER BY ${at} DESC,${key} DESC LIMIT @limit`,
    )
    .all({
      owner,
      ids: ids ? JSON.stringify(ids) : null,
      folders: options.folders ? JSON.stringify(options.folders) : null,
      agent: options.agent || null,
      teams: options.teamIds.length ? JSON.stringify(options.teamIds) : null,
      q: options.q || null,
      at: before?.[0] ?? null,
      key: before?.[1] ?? null,
      limit,
    }) as Row[];
}

function toCard(row: Row): Card {
  const artifact = row.key.startsWith("a:");
  const meta = JSON.parse(row.metadata) as Record<string, unknown>;
  const agent = {
    id: row.agent_id,
    name: row.agent_name,
    provider: row.provider,
  };
  const messageId = artifact ? text(meta.messageId) : row.id;
  const common = {
    id: row.key,
    source: {
      artifact_id: artifact ? row.id : null,
      message_id: messageId,
      conversation_id: row.conversation_id,
      run_id: row.run_id,
      agent_id: row.agent_id,
    },
    author:
      artifact || row.role === "assistant"
        ? {
            ...agent,
            kind: row.agent_id ? ("agent" as const) : ("unknown" as const),
          }
        : {
            id: null,
            name: null,
            provider: null,
            kind: row.personal
              ? ("owner" as const)
              : row.role === "system"
                ? ("system" as const)
                : ("unknown" as const),
          },
    recipient: !artifact && row.personal ? agent : null,
    context: {
      conversation_title: row.conversation_title,
      folder_id: row.folder_id,
      project_id: row.project_id,
      project_name: row.project_name,
      team_id: row.team_id,
    },
    content: row.content,
    format: artifact ? row.kind! : "markdown",
    created_at: row.created_at,
    updated_at: row.updated_at,
    saved: !!row.saved,
    attachments: cardAttachments(row.owner_id, meta),
    href: resultUrl({
      id: row.id,
      conversation_id: row.conversation_id,
      message_id: messageId,
    }),
  };
  if (!artifact) return { ...common, type: "message", role: row.role! };
  return {
    ...common,
    type: "result",
    title: row.title!,
    kind: row.kind!,
    version: row.version!,
    hidden: !!row.feed_hidden,
    display: {
      model: (() => {
        const connection =
          !text(meta.resolvedModel) &&
          text(meta.model) &&
          text(meta.connectionId)
            ? (modelConnection.get(row.owner_id, meta.connectionId) as
                { id: string; provider: string; models: string } | undefined)
            : undefined;
        return runModelName(meta, connection ? [connection] : []) || null;
      })(),
      tool: text(meta.tool),
      partial: meta.partial === true,
      imported: meta.origin === "import",
      uploaded: meta.uploaded === true || meta.upload === true,
      mime: text(meta.mime),
      filename: text(meta.name),
      size:
        typeof meta.size === "number" &&
        Number.isFinite(meta.size) &&
        meta.size >= 0
          ? meta.size
          : null,
      text: meta.text === true,
      download: (() => {
        for (const id of [text(meta.objectId), text(meta.rawObjectId)])
          if (id && ownedObject.get(row.owner_id, id))
            return "/api/objects/" + encodeURIComponent(id);
        return publishedFile.get(row.owner_id, row.id)
          ? "/api/artifacts/" + encodeURIComponent(row.id) + "/file"
          : null;
      })(),
      source: (() => {
        const source = meta.source as Record<string, unknown> | undefined;
        return source &&
          typeof source.url === "string" &&
          /^https?:\/\//.test(source.url)
          ? {
              url: source.url,
              title: text(source.title),
              excerpt: text(source.excerpt),
            }
          : null;
      })(),
      refreshable: artifactRefreshSource(row.agent_id, meta) !== null,
      app: !!meta.appResource,
      workflow_id: text(meta.workflowId),
    },
  };
}
function entry(row: Row, view: CardView): CardEntry {
  return {
    card: toCard(row),
    order: [row.order_at, row.key],
    saved: view === "saved" ? { at: row.saved_at!, label: row.label } : null,
  };
}
function rows(
  owner: string,
  options: Selection,
  params: Parameters<typeof query>[3],
) {
  return [
    ...query(owner, options, "artifact", params),
    ...query(owner, options, "message", params),
  ].sort(
    (a, b) =>
      b.order_at - a.order_at || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0),
  );
}
export function listCards(owner: string, input: unknown) {
  const options = CardListQuerySchema.parse(input);
  const observedAt = now();
  // Folder closure and team membership are mutable selection state too. Read
  // the watermark before resolving them so a concurrent move is replayed.
  const revision = options.view === "done"
    ? (db.prepare("SELECT COALESCE(max(revision),0) revision FROM done_card_revisions WHERE owner_id=?").get(owner) as {revision: number}).revision
    : resultsRevision(owner);
  const selected = selection(owner, options),
    scope = fingerprint(owner, selected);
  const before = readBefore(options.before, scope);
  if (options.view === "done") {
    const found = doneCards(owner, {...selected, before, limit: options.limit + 1, atTime: observedAt});
    const items = found.slice(0, options.limit);
    return {revision: encode([scope, revision, observedAt, ""]), items,
      next: found.length > options.limit ? encode([scope, items.at(-1)!.order]) : null};
  }
  const found = rows(owner, selected, { before, limit: options.limit + 1 });
  const items = found
    .slice(0, options.limit)
    .map((row) => entry(row, options.view));
  return {
    revision: encode([scope, revision]),
    items,
    next:
      found.length > options.limit
        ? encode([scope, items.at(-1)!.order])
        : null,
  };
}
export function cardDetail(
  owner: string,
  id: string,
  scope?: "results:read" | "cards:read",
): Card {
  if (!CardIdSchema.safeParse(id).success)
    throw new Problem(404, "Card not found");
  if (id.startsWith("d:")) {
    if (scope) throw new Problem(404, "Card not found");
    const found = doneCards(owner, {folders: null, teamIds: [], ids: [id], limit: 1, detail: true});
    if (!found.length) throw new Problem(404, "Card not found");
    return found[0].card;
  }
  const type = id.startsWith("a:") ? "artifact" : "message";
  const views: CardView[] =
    scope === "results:read" ? ["results"] : ["results", "saved", "sent"];
  for (const view of views) {
    const found = query(owner, selection(owner, { view }), type, {
      ids: [id.slice(2)],
    });
    if (found.length) return toCard(found[0]);
  }
  throw new Problem(404, "Card not found");
}
export function cardChanges(owner: string, input: unknown) {
  const options = CardChangesQuerySchema.parse(input);
  if (options.through !== undefined && options.view !== "results")
    throw new Problem(400, "through is a Results publication bound only");
  const revision = options.view === "done"
    ? (db.prepare("SELECT COALESCE(max(revision),0) revision FROM done_card_revisions WHERE owner_id=?").get(owner) as {revision: number}).revision
    : resultsRevision(owner);
  const selected = selection(owner, options),
    scope = fingerprint(owner, selected);
  const observedAt = now();
  let expiryAt = observedAt, expiryId = "";
  let after: number;
  if (options.view === "done") {
    try {
      const value = z.tuple([z.string(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.string()]).parse(decode(options.after));
      if (value[0] !== scope || value[1] > revision) throw new Error("Different domain");
      [, after, expiryAt, expiryId] = value;
    } catch { throw new Problem(409, "Resynchronization required: reload this card selection"); }
  } else after = readRevision(options.after, scope, revision);
  // Scan all entities for this owner, including irrelevant candidates, to make
  // progress through removals. Both prompt/message entities map to one identity.
  const changed = db
    .prepare(
      `SELECT revision,entity,object_id FROM ${options.view === "done" ? "done_card_revisions" : "feed_revisions"}
    WHERE owner_id=? AND revision>? AND revision<=? ORDER BY revision LIMIT 200`,
    )
    .all(owner, after, revision) as {
    revision: number;
    entity: string;
    object_id: string;
  }[];
  if (options.view === "done") {
    // Approval and stopped-watch expiry can change cards without a write. Carry a
    // second, bounded cursor so timestamp ties and revision backlogs cannot
    // skip those transitions or require an unbounded refresh.
    const remaining = 200 - changed.length;
    const expired = remaining ? db.prepare(`WITH expired_watches AS (
      SELECT conversation_id,updated_at+604800000 at FROM pr_watches
      WHERE owner_id=@owner AND state='stopped' AND updated_at+604800000>=@afterAt
        AND updated_at+604800000<=@now
    ), expiries AS (
      SELECT approval_until at,
        'd:'||COALESCE(NULLIF(card_key,''),'idle:'||conversation_id) key
      FROM feed_cards WHERE owner_id=@owner AND kind='thread' AND approval_until>=@afterAt AND approval_until<=@now
      UNION SELECT w.at,'d:run:'||r.id FROM expired_watches w JOIN runs r
        ON r.conversation_id=w.conversation_id AND r.owner_id=@owner
      UNION SELECT w.at,'d:message:'||m.id FROM expired_watches w JOIN messages m
        ON m.conversation_id=w.conversation_id AND m.owner_id=@owner
      UNION SELECT w.at,'d:idle:'||w.conversation_id FROM expired_watches w
    ) SELECT key id,at,key FROM expiries WHERE (at,key)>(@afterAt,@afterId)
      ORDER BY at,key LIMIT @limit`).all({owner,afterAt:expiryAt,afterId:expiryId,now:observedAt,limit:remaining+1}) as {id: string; at: number; key: string}[] : [];
    const pendingExpiry = !remaining || expired.length > remaining;
    const page = expired.slice(0, remaining);
    const last = page.at(-1);
    const ids = [...new Set([...changed.filter(row => row.entity === "done").map(row => row.object_id), ...page.map(row => row.key)])];
    const items = doneCards(owner, {...selected, ids, limit: 200, atTime: observedAt});
    const present = new Set(items.map(item => item.card.id));
    return {revision: encode([scope, changed.length === 200 ? changed.at(-1)!.revision : revision,
      pendingExpiry ? last?.at ?? expiryAt : observedAt,
      pendingExpiry ? last?.id ?? expiryId : ""]),
      items, removed: ids.filter(id => !present.has(id)), more: changed.length === 200 || pendingExpiry};
  }
  const artifacts = new Set(
    changed.filter((r) => r.entity === "artifact").map((r) => r.object_id),
  );
  const messages = new Set(
    changed
      .filter((r) => r.entity === "message" || r.entity === "prompt")
      .map((r) => r.object_id),
  );
  const current = [
    ...query(owner, selected, "artifact", { ids: [...artifacts], limit: 200 }),
    ...query(owner, selected, "message", { ids: [...messages], limit: 200 }),
  ];
  const candidates = new Set([
    ...(options.view !== "sent" ? [...artifacts].map((id) => "a:" + id) : []),
    ...(options.view !== "results" ? [...messages].map((id) => "m:" + id) : []),
  ]);
  const items: CardEntry[] = [];
  for (const row of current) {
    // `through` limits returned bodies, not selection membership. An eligible
    // older card is neither an upsert nor a removal for this visible window.
    candidates.delete(row.key);
    if (options.view !== "results" || row.order_at >= (options.through || 0)) {
      items.push(entry(row, options.view));
    }
  }
  return {
    revision: encode([
      scope,
      changed.length === 200 ? changed.at(-1)!.revision : revision,
    ]),
    items,
    removed: [...candidates],
    more: changed.length === 200,
  };
}
