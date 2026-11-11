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
  return database
    .transaction(() => {
      const prior = policy.read(request.owner, request.key);
      if (prior) {
        if (prior.request_hash !== hash)
          throw new Problem(409, policy.conflict);
        return policy.recover(prior);
      }
      const result = policy.create();
      if (result instanceof Promise) {
        void result.catch(() => {});
        throw new Error("A local creation must complete synchronously");
      }
      policy.record(request.owner, request.key, hash, result);
      return result;
    })
    .immediate();
}
