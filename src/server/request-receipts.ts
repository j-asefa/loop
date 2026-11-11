import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { Problem } from "../shared/problem.js";

// JSON objects are insensitive to field order; array order remains significant.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
        .join(",") +
      "}"
    );
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new Problem(400, "The request identity input is invalid.");
  return encoded;
}

export function requestHash(input: unknown): string {
  return createHash("sha256").update(canonical(input)).digest("hex");
}

export type ReceiptReservation<Result> =
  | { kind: "new"; prepared: unknown }
  | { kind: "replay"; result: Result }
  | { kind: "refused"; message: string };

type ReceiptPolicy<Result> = {
  mode: "local" | "external";
  reserve: () => ReceiptReservation<Result>;
  effect: () => Result | Promise<Result>;
  complete: (result: Result, prepared: unknown) => Result;
};

function replay<Result>(
  reserved: Exclude<ReceiptReservation<Result>, { kind: "new" }>,
): Result {
  if (reserved.kind === "refused") throw new Problem(409, reserved.message);
  return reserved.result;
}

export function withRequestReceipt<Result>(
  database: Database.Database,
  policy: ReceiptPolicy<Result> & { mode: "local" },
): Result;
export function withRequestReceipt<Result>(
  database: Database.Database,
  policy: ReceiptPolicy<Result>,
): Result | Promise<Result>;
/** Local effects and receipts commit together. External effects start only
 * after reservation commits; a failed effect or completion leaves it pending. */
export function withRequestReceipt<Result>(
  database: Database.Database,
  policy: ReceiptPolicy<Result>,
): Result | Promise<Result> {
  if (policy.mode === "external") {
    const reserved = database.transaction(policy.reserve).immediate();
    if (reserved.kind !== "new") return replay(reserved);
    return Promise.resolve()
      .then(policy.effect)
      .then((result) =>
        database
          .transaction(() => policy.complete(result, reserved.prepared))
          .immediate(),
      );
  }
  const outcome = database
    .transaction(() => {
      const reserved = policy.reserve();
      if (reserved.kind !== "new") return reserved;
      const result = policy.effect();
      if (result instanceof Promise) {
        void result.catch(() => {});
        throw new Error("A local receipt effect must complete synchronously");
      }
      return {
        kind: "replay" as const,
        result: policy.complete(result, reserved.prepared),
      };
    })
    .immediate();
  // Refusals follow the transaction so expired-result markers commit too.
  return replay(outcome);
}

/** The immediate transaction reserves the identity against concurrent local
 * creators. No effect or receipt becomes visible unless both commit. */
export function withCreationReceipt<
  Row extends { request_hash: string },
  Result,
>(
  database: Database.Database,
  request: { owner: string; key: string; input: unknown },
  policy: {
    read: (owner: string, key: string) => Row | undefined;
    conflict: string;
    recover: (row: Row) => Result;
    create: () => Result;
    record: (owner: string, key: string, hash: string, result: Result) => void;
  },
): Result {
  const hash = requestHash(request.input);
  return withRequestReceipt(database, {
    mode: "local",
    reserve: () => {
      const prior = policy.read(request.owner, request.key);
      if (!prior) return { kind: "new", prepared: undefined };
      if (prior.request_hash !== hash)
        return { kind: "refused", message: policy.conflict };
      return { kind: "replay", result: policy.recover(prior) };
    },
    effect: policy.create,
    complete: (result) => {
      policy.record(request.owner, request.key, hash, result);
      return result;
    },
  });
}
