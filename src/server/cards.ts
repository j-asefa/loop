import {
  readArtifactMetadata,
  artifactDisplayMetadata,
} from "../shared/artifact-metadata.js";
import { MessageRole } from "../shared/message-roles.js";
import { downloadLink } from "../shared/workspace-links.js";
import { DONE_CARD_PREFIX } from "../shared/done-card-id.js";
import { REVISION_PAGE_ITEMS } from "./pagination.js";
import { encodeCursor as encode, decodeCursor as decode } from "./cursors.js";
import * as cardRevisionDomainQueries from "./sql/card-revision-domain.js";
import * as doneCardRevisionsQueries from "./sql/done-card-revisions.js";
import * as feedRevisionsQueries from "./sql/feed-revisions.js";
import * as artifactQueries from "./sql/artifacts.js";
import * as messageQueries from "./sql/messages.js";
import * as connectionQueries from "./sql/connections.js";
import * as objectQueries from "./sql/objects.js";
import * as artifactObjectQueries from "./sql/artifact-objects.js";
import type { CardQuerySelection, CardQueryRow } from "./sql/artifacts.js";
import * as watchQueries from "./sql/pr-watches.js";
import type { TokenAdmission } from "../shared/token-scopes.js";
import { cardAttachments } from "./card-attachments.js";
import { doneCards } from "./done-cards.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db, now } from "./db.js";
import { Problem, ownedFolder, ownedAgent } from "./domain.js";
import { runModelName } from "../shared/model-display.js";
import { artifactRefreshSource } from "../shared/artifact-refresh.js";
import { projectFolders, resultUrl, resultsRevision } from "./results.js";
import { teamFilter } from "./teams.js";
import {
  CardChangesQuerySchema,
  CardIdSchema,
  CardListQuerySchema,
  type CardSelection,
  type CardView,
} from "../shared/cards.js";

// Builders supply wire strings; the HTTP registrar projects branded outputs.
type Card = z.input<typeof import("../shared/cards.js").CardSchema>;
type CardEntry = z.input<typeof import("../shared/cards.js").CardEntrySchema>;
type Selection = CardQuerySelection;
type Row = CardQueryRow;
const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
function selection(owner: string, input: CardSelection): Selection {
  if (input.read !== undefined && input.view !== "done")
    throw new Problem(400, "Read status is supported only for Done");
  if (["results", "done"].includes(input.view) && input.q !== undefined)
    throw new Problem(400, "Search is supported for Saved and Sent");
  if (input.project) ownedFolder(input.project, owner);
  if (input.agent) ownedAgent(input.agent, owner);
  return {
    ...input,
    teamIds: teamFilter(input.teams, owner).sort(),
    folders: input.project ? projectFolders(owner, input.project) : null,
  };
}
function fingerprint(owner: string, options: Selection) {
  const { epoch } = cardRevisionDomainQueries.epoch(db);
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
        options.read || null,
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
    const [domain, revision] = decode(value, revisionTuple);
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
    const [domain, order] = decode(value, z.tuple([z.string(), orderTuple]));
    if (domain !== scope) throw new Error("Different selection");
    return order;
  } catch {
    throw new Problem(400, "Invalid card page cursor for this selection");
  }
}

function query(
  owner: string,
  options: Selection,
  type: "artifact" | "message",
  params: Parameters<typeof artifactQueries.cards>[3] = {},
) {
  return type === "artifact"
    ? artifactQueries.cards(db, owner, options, params)
    : messageQueries.cards(db, owner, options, params);
}

function toCard(row: Row): Card {
  const artifact = row.key.startsWith("a:");
  const meta = artifact
    ? artifactDisplayMetadata(
        readArtifactMetadata(row.artifact_role!, row.metadata),
      )
    : (JSON.parse(row.metadata) as Record<string, unknown>);
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
  if (!artifact)
    return {
      ...common,
      type: "message",
      role: row.role! as MessageRole,
    };
  return {
    ...common,
    type: "result",
    title: row.title!,
    kind: row.kind!,
    role: row.artifact_role!,
    version: row.version!,
    hidden: !!row.feed_hidden,
    display: {
      model: (() => {
        const connection =
          !text(meta.resolvedModel) &&
          text(meta.model) &&
          text(meta.connectionId)
            ? connectionQueries.cardModel(
                db,
                row.owner_id,
                text(meta.connectionId)!,
              )
            : undefined;
        return runModelName(meta, connection ? [connection] : []) || null;
      })(),
      tool: text(meta.tool),
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
          if (id && objectQueries.cardOwned(db, row.owner_id, id))
            return downloadLink({
              artifactId: row.id,
              objectId: id,
              published: false,
            });
        return downloadLink({
          artifactId: row.id,
          published: !!artifactObjectQueries.cardPublished(
            db,
            row.owner_id,
            row.id,
          ),
        });
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
  const revision =
    options.view === "done"
      ? doneCardRevisionsQueries.revision(db, owner)!.revision
      : resultsRevision(owner);
  const selected = selection(owner, options),
    scope = fingerprint(owner, selected);
  const before = readBefore(options.before, scope);
  if (options.view === "done") {
    const found = doneCards(owner, {
      ...selected,
      before,
      limit: options.limit + 1,
      atTime: observedAt,
    });
    const items = found.slice(0, options.limit);
    return {
      revision: encode([scope, revision, observedAt, ""]),
      items,
      next:
        found.length > options.limit
          ? encode([scope, items.at(-1)!.order])
          : null,
    };
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
  admission?: readonly TokenAdmission[],
): Card {
  if (!CardIdSchema.safeParse(id).success)
    throw new Problem(404, "Card not found");
  if (id.startsWith(DONE_CARD_PREFIX)) {
    if (admission) throw new Problem(404, "Card not found");
    const found = doneCards(owner, {
      folders: null,
      teamIds: [],
      ids: [id],
      limit: 1,
      detail: true,
    });
    if (!found.length) throw new Problem(404, "Card not found");
    return found[0].card;
  }
  const type = id.startsWith("a:") ? "artifact" : "message";
  const views: CardView[] = ["results", "saved", "sent"];
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
  const revision =
    options.view === "done"
      ? doneCardRevisionsQueries.revision(db, owner)!.revision
      : resultsRevision(owner);
  const selected = selection(owner, options),
    scope = fingerprint(owner, selected);
  const observedAt = now();
  let expiryAt = observedAt,
    expiryId = "";
  let after: number;
  if (options.view === "done") {
    try {
      const value = decode(
        options.after,
        z.tuple([
          z.string(),
          z.number().int().nonnegative(),
          z.number().int().nonnegative(),
          z.string(),
        ]),
      );
      if (value[0] !== scope || value[1] > revision)
        throw new Error("Different domain");
      [, after, expiryAt, expiryId] = value;
    } catch {
      throw new Problem(
        409,
        "Resynchronization required: reload this card selection",
      );
    }
  } else after = readRevision(options.after, scope, revision);
  // Scan all entities for this owner, including irrelevant candidates, to make
  // progress through removals. Both prompt/message entities map to one identity.
  const changed =
    options.view === "done"
      ? doneCardRevisionsQueries.cardChanges(
          db,
          owner,
          after,
          revision,
          REVISION_PAGE_ITEMS,
        )
      : feedRevisionsQueries.cardChanges(
          db,
          owner,
          after,
          revision,
          REVISION_PAGE_ITEMS,
        );
  if (options.view === "done") {
    // Approval and stopped-watch expiry can change cards without a write. Carry a
    // second, bounded cursor so timestamp ties and revision backlogs cannot
    // skip those transitions or require an unbounded refresh.
    const remaining = REVISION_PAGE_ITEMS - changed.length;
    const expired = remaining
      ? watchQueries.expiredCards(db, {
          owner,
          afterAt: expiryAt,
          afterId: expiryId,
          now: observedAt,
          limit: remaining + 1,
        })
      : [];
    const pendingExpiry = !remaining || expired.length > remaining;
    const page = expired.slice(0, remaining);
    const last = page.at(-1);
    const ids = [
      ...new Set([
        ...changed
          .filter((row) => row.entity === "done")
          .map((row) => row.object_id),
        ...page.map((row) => row.key),
      ]),
    ];
    const items = doneCards(owner, {
      ...selected,
      ids,
      limit: REVISION_PAGE_ITEMS,
      atTime: observedAt,
    });
    const present = new Set(items.map((item) => item.card.id));
    return {
      revision: encode([
        scope,
        changed.length === REVISION_PAGE_ITEMS
          ? changed.at(-1)!.revision
          : revision,
        pendingExpiry ? (last?.at ?? expiryAt) : observedAt,
        pendingExpiry ? (last?.id ?? expiryId) : "",
      ]),
      items,
      removed: ids.filter((id) => !present.has(id)),
      more: changed.length === REVISION_PAGE_ITEMS || pendingExpiry,
    };
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
    ...query(owner, selected, "artifact", {
      ids: [...artifacts],
      limit: REVISION_PAGE_ITEMS,
    }),
    ...query(owner, selected, "message", {
      ids: [...messages],
      limit: REVISION_PAGE_ITEMS,
    }),
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
      changed.length === REVISION_PAGE_ITEMS
        ? changed.at(-1)!.revision
        : revision,
    ]),
    items,
    removed: [...candidates],
    more: changed.length === REVISION_PAGE_ITEMS,
  };
}
