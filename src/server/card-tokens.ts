import { createHash } from "node:crypto";
import type { CardChanges, CardPage } from "../shared/cards.js";
import type { IncomingMessage } from "node:http";
import { db } from "./db.js";
import { config } from "./config.js";
import { companionMode } from "./profile.js";
import { OWNER } from "./native-sessions.js";
import { Problem } from "./domain.js";
import {
  CardGrantSchema,
  CreateCardTokenSchema,
  cardAuthorization,
  type CardAuthorization,
  type CardToken,
  type CardGrant,
} from "../shared/card-access.js";

const columns = "id,name,scope,created_at,revoked_at,last_used_at";
const digest = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
export function listCardTokens(owner: string): CardToken[] {
  return db
    .prepare(
      `SELECT ${columns} FROM card_tokens WHERE owner_id=? ORDER BY created_at DESC,id DESC`,
    )
    .all(owner) as CardToken[];
}
export function createCardToken(owner: string, input: unknown) {
  const options = CreateCardTokenSchema.parse(input);
  return db
    .transaction(() => {
      const existing = db
        .prepare("SELECT * FROM card_tokens WHERE id=?")
        .get(options.request_id) as
        (CardToken & { owner_id: string; digest: string }) | undefined;
      if (existing) {
        if (
          existing.owner_id !== owner ||
          existing.digest !== digest(options.secret) ||
          existing.name !== options.name ||
          existing.scope !== options.scope ||
          existing.revoked_at !== null
        )
          throw new Problem(
            409,
            "This token creation is already settled; use a new creation request",
          );
        const token = db
          .prepare(`SELECT ${columns} FROM card_tokens WHERE id=?`)
          .get(existing.id) as CardToken;
        return { token, secret: options.secret };
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
      const token: CardToken = {
        id: options.request_id,
        name: options.name,
        scope: options.scope,
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
      return { token, secret };
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
export function tokenCardPage<T extends CardChanges | CardPage>(
  owner: string,
  tokenId: string | undefined,
  page: T,
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

export function authenticateCardToken(req: IncomingMessage): CardAuthorization {
  const header = req.headers.authorization;
  const match =
    typeof header === "string" &&
    /^Bearer (loop_card_[A-Za-z0-9_-]{43})$/i.exec(header);
  if (!match) throw new Problem(401, "Invalid card credential");
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
      if (
        !token ||
        token.revoked_at !== null ||
        token.owner_id !== owner ||
        !CardGrantSchema.safeParse(token.scope).success
      )
        throw new Problem(401, "Invalid card credential");
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
          "Too many card requests. Try again in a minute.",
        );
      db.prepare(
        "UPDATE card_tokens SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<=?)",
      ).run(now, token.id, now - 60000);
      return {
        owner: token.owner_id,
        scope: token.scope as CardGrant,
        tokenId: token.id,
      };
    })
    .immediate();
}
