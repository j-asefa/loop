import { InvalidRow } from "./row-schemas.js";
import * as tokenRequestsQueries from "./sql/token-requests.js";
import { requestHash } from "./request-receipts.js";
import { z } from "zod";
import { db, now } from "./db.js";
import { Problem } from "../shared/problem.js";

export type TokenRequest = {
  owner: string;
  tokenId: string;
  identity: string;
  operation: string;
  input: { params: unknown; body: unknown };
};
export type TokenResult = { status: number; body: unknown };
export type TokenWrite = (
  request: TokenRequest,
  effect: () => TokenResult | Promise<TokenResult>,
) => TokenResult | Promise<TokenResult>;
type TokenWritePolicy = {
  mode: "local" | "external";
  // Capture owner/generation checks before admitting a new effect. A completed
  // replay only projects its saved locator; it never re-enters this preparation.
  prepare?: (request: TokenRequest) => unknown;
  locate: (
    request: TokenRequest,
    response: unknown,
    prepared: unknown,
  ) => unknown;
  project: (owner: string, locator: unknown) => unknown;
};

const Receipt = z.object({
  operation: z.string().nullable(),
  request_hash: z.string().nullable(),
  state: z.enum(["pending", "complete"]),
  response_status: z.number().int().nullable(),
  locator: z.string().nullable(),
});
const RETAIN_RESULT_MS = 24 * 60 * 60 * 1000;

type Reserved =
  | { kind: "new"; prepared: unknown }
  | { kind: "replay"; result: TokenResult }
  | { kind: "refused"; message: string };

function reserve(request: TokenRequest, policy: TokenWritePolicy): Reserved {
  const key = [request.owner, request.tokenId, request.identity] as const;
  const hash = requestHash(request.input);
  // Keep the primary-key marker. Old keys must never become new requests, even
  // after the response data expires or a client retries after a long outage.
  tokenRequestsQueries.expireResults(
    db,
    request.owner,
    request.tokenId,
    now() - RETAIN_RESULT_MS,
  );
  const stored = (() => {
    try {
      return tokenRequestsQueries.receipt(db, ...key);
    } catch (error) {
      if (error instanceof InvalidRow)
        throw new Problem(500, "The request receipt is unavailable.");
      throw error;
    }
  })();
  if (stored) {
    const parsed = Receipt.safeParse(stored);
    if (!parsed.success)
      throw new Problem(500, "The request receipt is unavailable.");
    const row = parsed.data;
    if (
      row.operation !== null &&
      (row.operation !== request.operation || row.request_hash !== hash)
    )
      return {
        kind: "refused",
        message:
          "This request identity belongs to different input or another operation.",
      };
    if (row.state === "pending")
      return {
        kind: "refused",
        message:
          "The original request's outcome is uncertain. Inspect workspace state; this identity will not dispatch again.",
      };
    if (
      row.operation === null ||
      row.response_status === null ||
      row.locator === null
    )
      return {
        kind: "refused",
        message:
          "This request identity has expired. Its effect will not be repeated.",
      };
    let locator: unknown;
    try {
      locator = JSON.parse(row.locator);
    } catch {
      throw new Problem(500, "The request receipt is unavailable.");
    }
    return {
      kind: "replay",
      result: {
        status: row.response_status,
        body: policy.project(request.owner, locator),
      },
    };
  }
  const prepared = policy.prepare?.(request);
  tokenRequestsQueries.reserve(db, ...key, request.operation, hash, now());
  return { kind: "new", prepared };
}

function complete(
  request: TokenRequest,
  policy: TokenWritePolicy,
  result: TokenResult,
  prepared: unknown,
) {
  // The registrar projected this response before the locator can persist it.
  const locator = JSON.stringify(policy.locate(request, result.body, prepared));
  if (locator === undefined)
    throw new Error("A token write must record a result locator");
  const changed = tokenRequestsQueries.complete(
    db,
    result.status,
    locator,
    now(),
    request.owner,
    request.tokenId,
    request.identity,
  ).changes;
  if (changed !== 1)
    throw new Problem(409, "The request identity is no longer pending.");
  return result;
}

function replay(reserved: Exclude<Reserved, { kind: "new" }>): TokenResult {
  if (reserved.kind === "refused") throw new Problem(409, reserved.message);
  return reserved.result;
}

/** Local effects and receipts share one immediate transaction. External effects
 * start only after pending commits, and any failure leaves that identity pending. */
export function tokenWrite(policy: TokenWritePolicy): TokenWrite {
  return (request, effect) => {
    if (policy.mode === "external") {
      const reserved = db
        .transaction(() => reserve(request, policy))
        .immediate();
      if (reserved.kind !== "new") return replay(reserved);
      return Promise.resolve()
        .then(effect)
        .then((result) =>
          db
            .transaction(() =>
              complete(request, policy, result, reserved.prepared),
            )
            .immediate(),
        );
    }
    const outcome = db
      .transaction(() => {
        const reserved = reserve(request, policy);
        if (reserved.kind !== "new") return reserved;
        const result = effect();
        if (result instanceof Promise) {
          void result.catch(() => {});
          throw new Error("A local token write must complete synchronously");
        }
        return {
          kind: "replay" as const,
          result: complete(request, policy, result, reserved.prepared),
        };
      })
      .immediate();
    // Refusals follow the transaction so expired-result markers commit too.
    return replay(outcome);
  };
}
