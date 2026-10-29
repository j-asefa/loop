import { createHash } from "node:crypto";
import type { CardChanges, CardPage } from "../shared/cards.js";
import type { IncomingMessage } from "node:http";
import { db } from "./db.js";
import { config } from "./config.js";
import { companionMode } from "./profile.js";
import { OWNER } from "./native-sessions.js";
import { Problem } from "./domain.js";
import {
  CreateCardTokenSchema,
  cardAuthorization,
  type CardAuthorization,
  type CardToken,
} from "../shared/card-access.js";

import {
  TokenAdmissions,
  TokenScope,
  type TokenAdmission,
} from "../shared/token-scopes.js";

type TokenRow = {
  id: string;
  name: string;
  scope: string;
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
};
function storedAdmission(value: string): TokenAdmission[] | undefined {
  try {
    const parsed = TokenAdmissions.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
function publicToken(row: TokenRow): CardToken {
  const admission = storedAdmission(row.scope);
  if (!admission) throw new Problem(500, "Token metadata unavailable");
  const { id, name, created_at, revoked_at, last_used_at } = row;
  const fields = { id, name, created_at, revoked_at, last_used_at };
  if (
    admission.length === 1 &&
    (admission[0] === "results:read" || admission[0] === "cards:read")
  )
    return { ...fields, scope: admission[0] };
  const scopes = TokenScope.array().safeParse(admission);
  if (!scopes.success) throw new Problem(500, "Token metadata unavailable");
  return { ...fields, scopes: scopes.data };
}

const columns = "id,name,scope,created_at,revoked_at,last_used_at";
const digest = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
export function listCardTokens(owner: string): CardToken[] {
  const rows = db
    .prepare(
      `SELECT ${columns} FROM card_tokens WHERE owner_id=? ORDER BY created_at DESC,id DESC`,
    )
    .all(owner) as TokenRow[];
  return rows.map(publicToken);
}
export function createCardToken(owner: string, input: unknown) {
  const options = CreateCardTokenSchema.parse(input);
  const admission =
    "scopes" in options ? [...new Set(options.scopes)].sort() : [options.scope];
  const stored = JSON.stringify(admission);
  return db
    .transaction(() => {
      const existing = db
        .prepare("SELECT * FROM card_tokens WHERE id=?")
        .get(options.request_id) as
        (TokenRow & { owner_id: string; digest: string }) | undefined;
      if (existing) {
        if (
          existing.owner_id !== owner ||
          existing.digest !== digest(options.secret) ||
          existing.name !== options.name ||
          existing.scope !== stored ||
          existing.revoked_at !== null
        )
          throw new Problem(
            409,
            "This token creation is already settled; use a new creation request",
          );
        const token = db
          .prepare(`SELECT ${columns} FROM card_tokens WHERE id=?`)
          .get(existing.id) as TokenRow;
        return { token: publicToken(token), secret: options.secret };
      }
      if (
        db
          .prepare("SELECT 1 FROM card_token_ids WHERE id=?")
          .get(options.request_id)
      )
        throw new Problem(
          409,
          "This token creation is already settled; use a new creation request",
        );
      if (
        db
          .prepare(
            "SELECT 1 FROM card_token_ids WHERE digest=? UNION ALL SELECT 1 FROM card_tokens WHERE digest=? LIMIT 1",
          )
          .get(digest(options.secret), digest(options.secret))
      )
        throw new Problem(409, "Use a new secret for a new token creation");
      const { n } = db
        .prepare(
          "SELECT count(*) n FROM card_tokens WHERE owner_id=? AND revoked_at IS NULL",
        )
        .get(owner) as { n: number };
      if (n >= 50)
        throw new Problem(
          409,
          "Revoke an existing token before creating another (50 active tokens maximum)",
        );
      // Retain a bounded recent revocation history. Active credentials are never pruned.
      db.prepare(
        "DELETE FROM card_tokens WHERE owner_id=? AND revoked_at IS NOT NULL AND id NOT IN (SELECT id FROM card_tokens WHERE owner_id=? AND revoked_at IS NOT NULL ORDER BY revoked_at DESC,id DESC LIMIT 50)",
      ).run(owner, owner);
      db.prepare("INSERT INTO card_token_ids VALUES(?,?,?)").run(
        options.request_id,
        owner,
        digest(options.secret),
      );
      const secret = options.secret;
      const token: TokenRow = {
        id: options.request_id,
        name: options.name,
        scope: stored,
        created_at: Date.now(),
        revoked_at: null,
        last_used_at: null,
      };
      db.prepare(
        "INSERT INTO card_tokens(id,owner_id,name,digest,scope,created_at) VALUES(?,?,?,?,?,?)",
      ).run(
        token.id,
        owner,
        token.name,
        digest(secret),
        token.scope,
        token.created_at,
      );
      return { token: publicToken(token), secret };
    })
    .immediate();
}
export function revokeCardToken(owner: string, tokenId: string) {
  db.transaction(() => {
    const changed = db
      .prepare(
        "UPDATE card_tokens SET revoked_at=coalesce(revoked_at,?) WHERE id=? AND owner_id=?",
      )
      .run(Date.now(), tokenId, owner);
    if (!changed.changes) throw new Problem(404, "Token not found");
    db.prepare(
      "DELETE FROM card_token_reads WHERE token_id=? AND owner_id=?",
    ).run(tokenId, owner);
  }).immediate();
}

/** Token-side read bookkeeping, never product state. Unknown/ineligible IDs
 * must not escape via tombstones. Replacing a credential requires a backfill. */
export function recordCardRead(owner: string, tokenId: string, ids: string[]) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO card_token_reads(token_id,owner_id,card_id) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM card_tokens WHERE id=? AND owner_id=? AND revoked_at IS NULL)",
  );
  db.transaction(() => {
    for (const id of ids) insert.run(tokenId, owner, id, tokenId, owner);
  }).immediate();
}

/** Legacy Results pages use bare IDs; disclosure identities remain qualified
 * exactly like Cards so removals never reveal a record this token did not read. */
export function tokenResultPage<
  T extends { items: { id: string }[]; removed?: string[] },
>(
  owner: string,
  tokenId: string | undefined,
  page: T,
  removedPrefix: "a:" | "m:" = "a:",
  disclose = true,
): T {
  if (!tokenId) return page;
  return db
    .transaction(() => {
      if (page.removed) {
        const known = db.prepare(
          "SELECT 1 FROM card_token_reads WHERE token_id=? AND owner_id=? AND card_id=?",
        );
        page.removed = page.removed.filter((value) =>
          known.get(tokenId, owner, removedPrefix + value),
        );
      }
      if (disclose)
        recordCardRead(
          owner,
          tokenId,
          page.items.map((item) => ("role" in item ? "m:" : "a:") + item.id),
        );
      return page;
    })
    .immediate();
}
export function tokenCardPage<T extends CardChanges | CardPage>(
  owner: string,
  tokenId: string | undefined,
  page: T,
  disclose = true,
): T {
  if (!tokenId) return page;
  return db
    .transaction(() => {
      if ("removed" in page && page.removed.length) {
        const known = new Set(
          (
            db
              .prepare(
                "SELECT card_id FROM card_token_reads WHERE token_id=? AND owner_id=? AND card_id IN (SELECT value FROM json_each(?))",
              )
              .all(tokenId, owner, JSON.stringify(page.removed)) as {
              card_id: string;
            }[]
          ).map((row) => row.card_id),
        );
        page.removed = page.removed.filter((id) => known.has(id));
      }
      if (disclose)
        recordCardRead(
          owner,
          tokenId,
          page.items.map((item) => item.card.id),
        );
      return page;
    })
    .immediate();
}

export type CardRequest = IncomingMessage & {
  [cardAuthorization]?: CardAuthorization;
};

/** Long-lived readers recheck authority without charging a new HTTP request. */
export function activeIntegrationToken(
  owner: string,
  tokenId: string,
  scope: TokenAdmission,
) {
  const token = db
    .prepare(
      "SELECT scope FROM card_tokens WHERE id=? AND owner_id=? AND revoked_at IS NULL",
    )
    .get(tokenId, owner) as { scope: string } | undefined;
  const installedOwner = companionMode
    ? OWNER
    : config.authMode === "single-user"
      ? (
          db.prepare("SELECT owner_id FROM installation WHERE id=1").get() as
            { owner_id: string } | undefined
        )?.owner_id
      : owner;
  return (
    owner === installedOwner &&
    !!token &&
    !!storedAdmission(token.scope)?.includes(scope)
  );
}

export function authenticateCardToken(req: IncomingMessage): CardAuthorization {
  const header = req.headers.authorization;
  const match =
    typeof header === "string" &&
    /^Bearer (loop_(?:card|token)_[A-Za-z0-9_-]{43})$/i.exec(header);
  if (!match) throw new Problem(401, "Invalid integration credential");
  // This query is deliberately performed for every request, including HEAD.
  // Last-use throttling must never become a revocation cache.
  return db
    .transaction(() => {
      const token = db
        .prepare(
          "SELECT id,owner_id,scope,revoked_at FROM card_tokens WHERE digest=?",
        )
        .get(digest(match[1])) as
        | {
            id: string;
            owner_id: string;
            scope: string;
            revoked_at: number | null;
          }
        | undefined;
      const owner = companionMode
        ? OWNER
        : config.authMode === "single-user"
          ? (
              db
                .prepare("SELECT owner_id FROM installation WHERE id=1")
                .get() as { owner_id: string } | undefined
            )?.owner_id
          : token?.owner_id;
      const admission = token && storedAdmission(token.scope);
      if (
        !token ||
        token.revoked_at !== null ||
        token.owner_id !== owner ||
        !admission
      )
        throw new Problem(401, "Invalid integration credential");
      const now = Date.now(),
        window = Math.floor(now / 60000);
      const perToken = db
        .prepare(
          "UPDATE card_tokens SET request_window=?,request_count=CASE WHEN request_window=? THEN request_count+1 ELSE 1 END WHERE id=? RETURNING request_count n",
        )
        .get(window, window, token.id) as { n: number };
      const perOwner = db
        .prepare(
          "INSERT INTO card_owner_limits VALUES(?,?,1) ON CONFLICT(owner_id) DO UPDATE SET window=excluded.window,count=CASE WHEN card_owner_limits.window=excluded.window THEN card_owner_limits.count+1 ELSE 1 END RETURNING count n",
        )
        .get(owner, window) as { n: number };
      if (perToken.n > 120 || perOwner.n > 600)
        throw new Problem(
          429,
          "Too many integration requests. Try again in a minute.",
        );
      db.prepare(
        "UPDATE card_tokens SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<=?)",
      ).run(now, token.id, now - 60000);
      return {
        owner: token.owner_id,
        admission,
        tokenId: token.id,
      };
    })
    .immediate();
}
