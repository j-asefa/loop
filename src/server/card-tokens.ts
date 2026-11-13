type CardToken = import("zod").input<
  typeof import("../shared/card-token-schemas.js").CardTokenSchema
>;
import { InvalidRow } from "./row-schemas.js";
import * as cardTokensQueries from "./sql/card-tokens.js";
import * as cardTokenIdsQueries from "./sql/card-token-ids.js";
import * as cardTokenReadsQueries from "./sql/card-token-reads.js";
import * as cardOwnerLimitsQueries from "./sql/card-owner-limits.js";
import { createHash } from "node:crypto";
type CardChanges = import("zod").input<
  typeof import("../shared/cards.js").CardChangesSchema
>;
type CardPage = import("zod").input<
  typeof import("../shared/cards.js").CardPageSchema
>;
import type { IncomingMessage } from "node:http";
import { db } from "./db.js";
import { OWNER } from "./workspace-identity.js";
import { Problem } from "./domain.js";
import {
  CreateCardTokenSchema,
  cardAuthorization,
  type CardAuthorization,
} from "../shared/card-access.js";

import {
  TokenAdmissions,
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
  return { ...fields, scopes: admission };
}

const digest = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
export function listCardTokens(owner: string): CardToken[] {
  const rows = cardTokensQueries.publicList(db, owner);
  return rows.map(publicToken);
}
export function createCardToken(owner: string, input: unknown) {
  const options = CreateCardTokenSchema.parse(input);
  const admission = [...new Set(options.scopes)].sort();
  const stored = JSON.stringify(admission);
  return db
    .transaction(() => {
      const existing = cardTokensQueries.byId(db, options.request_id);
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
        const token = cardTokensQueries.publicById(db, existing.id)!;
        return { token: publicToken(token), secret: options.secret };
      }
      if (cardTokenIdsQueries.exists(db, options.request_id))
        throw new Problem(
          409,
          "This token creation is already settled; use a new creation request",
        );
      if (cardTokenIdsQueries.digestExists(db, digest(options.secret)))
        throw new Problem(409, "Use a new secret for a new token creation");
      const { n } = cardTokensQueries.activeCount(db, owner)!;
      if (n >= 50)
        throw new Problem(
          409,
          "Revoke an existing token before creating another (50 active tokens maximum)",
        );
      // Retain a bounded recent revocation history. Active credentials are never pruned.
      cardTokensQueries.pruneRevoked(db, owner);
      cardTokenIdsQueries.insert(
        db,
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
      cardTokensQueries.insert(
        db,
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
    const changed = cardTokensQueries.revoke(db, Date.now(), tokenId, owner);
    if (!changed.changes) throw new Problem(404, "Token not found");
    cardTokenReadsQueries.remove(db, tokenId, owner);
  }).immediate();
}

/** Token-side read bookkeeping, never product state. Unknown/ineligible IDs
 * must not escape via tombstones. Replacing a credential requires a backfill. */
export function recordCardRead(owner: string, tokenId: string, ids: string[]) {
  db.transaction(() => {
    for (const id of ids)
      cardTokenReadsQueries.insertActive(db, tokenId, owner, id);
  }).immediate();
}

/** Results pages use bare IDs; disclosure identities remain qualified
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
        page.removed = page.removed.filter((value) =>
          cardTokenReadsQueries.known(
            db,
            tokenId,
            owner,
            removedPrefix + value,
          ),
        );
      }
      if (disclose)
        recordCardRead(
          owner,
          tokenId,
          // Artifacts carry a `kind`; messages never do. `role` cannot
          // discriminate: artifacts now have one too, and a misrecorded
          // disclosure would leak removals for records this token never read.
          page.items.map((item) => ("kind" in item ? "a:" : "m:") + item.id),
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
          cardTokenReadsQueries
            .knownPage(db, tokenId, owner, JSON.stringify(page.removed))
            .map((row) => row.card_id),
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
  const token = credentialRow(() =>
    cardTokensQueries.activeScope(db, tokenId, owner),
  ) as { scope: string } | undefined;
  return (
    owner === OWNER &&
    !!token &&
    !!storedAdmission(token.scope)?.includes(scope)
  );
}

const TOKEN_RATE_WINDOW_SECONDS = 60;

export function authenticateCardToken(req: IncomingMessage): CardAuthorization {
  const header = req.headers.authorization;
  const match =
    typeof header === "string" &&
    /^Bearer (loop_token_[A-Za-z0-9_-]{43})$/i.exec(header);
  if (!match) throw new Problem(401, "Invalid integration credential");
  // This query is deliberately performed for every request, including HEAD.
  // Last-use throttling must never become a revocation cache.
  return db
    .transaction(() => {
      const token = credentialRow(() =>
        cardTokensQueries.byDigest(db, digest(match[1])),
      ) as
        | {
            id: string;
            owner_id: string;
            scope: string;
            revoked_at: number | null;
          }
        | undefined;
      const admission = token && storedAdmission(token.scope);
      if (
        !token ||
        token.revoked_at !== null ||
        token.owner_id !== OWNER ||
        !admission
      )
        throw new Problem(401, "Invalid integration credential");
      const now = Date.now(),
        window = Math.floor(now / (TOKEN_RATE_WINDOW_SECONDS * 1000));
      const perToken = cardTokensQueries.charge(db, window, token.id)!;
      const perOwner = cardOwnerLimitsQueries.charge(db, OWNER, window)!;
      if (perToken.n > 120 || perOwner.n > 600)
        throw new Problem(
          429,
          "Too many integration requests. Try again in a minute.",
          undefined,
          { headers: { "Retry-After": String(TOKEN_RATE_WINDOW_SECONDS) } },
        );
      cardTokensQueries.touch(db, now, token.id, now - 60000);
      return {
        owner: token.owner_id,
        admission,
        tokenId: token.id,
      };
    })
    .immediate();
}

function credentialRow<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (error instanceof InvalidRow) return undefined;
    throw error;
  }
}
