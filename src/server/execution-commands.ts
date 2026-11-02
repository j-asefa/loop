import * as executionCommandsQueries from "./sql/execution-commands.js";
import { ExecutionRefused } from "./execution-refusal.js";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { db, now } from "./db.js";
import { Problem } from "./domain.js";
import { ExecutionProblem } from "../shared/problem.js";
import type { ExecutionRequest } from "../shared/execution-authority.js";

type Receipt = {
  method: string;
  digest: string;
  generation: string;
  state: string;
  result: string | null;
};
const inflight = new Map<string, Promise<unknown>>();
// Short sign-in codes must not be recoverable by guessing against a saved
// digest. This key exists only in the authority that can reconcile the session.
const sessionDigestKey = randomBytes(32);
// Keep identities indefinitely to prevent old retries from replaying effects.
// Response bodies are a bounded cache; a compacted success remains a success
// tombstone and requires the caller to inspect current state instead of rerun.
function compactResults(owner: string, current: string) {
  const rows = executionCommandsQueries.resultSizes(db, owner, current) as {
    command_id: string;
    bytes: number;
  }[];
  let count = 0,
    bytes = 0;
  for (const row of rows) {
    if (++count <= 64 && bytes + row.bytes <= 4 * 1024 * 1024)
      bytes += row.bytes;
    else executionCommandsQueries.compact(db, owner, row.command_id);
  }
}
const uncertain = () =>
  new ExecutionProblem(
    409,
    "Execution command outcome is unknown. It was not replayed; inspect the current native state before starting a new command.",
    "unknown",
  );

/** Persist intent before handing control to a harness. A crashed/stale request
 * is never retried merely because a caller or a worker generation reconnects. */
export async function executionCommand(
  request: ExecutionRequest,
  apply: () => Promise<unknown>,
  sessionReplay?: () => unknown,
) {
  const commandId = request.commandId!;
  const key = JSON.stringify([request.owner, commandId]);
  const digest = (
    sessionReplay
      ? createHmac("sha256", sessionDigestKey)
      : createHash("sha256")
  )
    .update(JSON.stringify([request.method, request.input]))
    .digest("hex");
  const prior = db
    .transaction(() => {
      const row = executionCommandsQueries.receipt(
        db,
        request.owner,
        commandId,
      ) as Receipt | undefined;
      if (row) return row;
      executionCommandsQueries.start(
        db,
        request.owner,
        commandId,
        request.method,
        digest,
        request.generation,
        now(),
        now(),
      );
    })
    .immediate();
  if (prior) {
    if (prior.method !== request.method)
      throw new Problem(409, "Command ID belongs to different input.");
    if (sessionReplay && prior.generation !== request.generation)
      throw uncertain();
    if (prior.digest !== digest)
      throw new Problem(409, "Command ID belongs to different input.");
    const pending = inflight.get(key);
    if (pending && prior.generation === request.generation) return pending;
    if (prior.state === "completed") {
      if (sessionReplay) {
        if (prior.generation !== request.generation) throw uncertain();
        return sessionReplay();
      }
      if (prior.result !== null) return JSON.parse(prior.result);
      throw new ExecutionProblem(
        409,
        "Execution command completed, but its saved response expired. It was not replayed; inspect the current native state before starting a new command.",
        "completed",
      );
    }
    throw uncertain();
  }
  const promise = Promise.resolve()
    .then(apply)
    .then(
      (result) => {
        // Sign-in replies can contain short-lived codes. Never persist those or
        // submitted credentials; only the digest and the command state travel.
        db.transaction(() => {
          executionCommandsQueries.complete(
            db,
            sessionReplay ? null : JSON.stringify(result),
            now(),
            request.owner,
            commandId,
            request.generation,
          );
          compactResults(request.owner, commandId);
        }).immediate();
        return result;
      },
      (error) => {
        if (error instanceof ExecutionRefused) {
          executionCommandsQueries.refused(
            db,
            request.owner,
            commandId,
            request.generation,
          );
        } else {
          executionCommandsQueries.unknown(
            db,
            now(),
            request.owner,
            commandId,
            request.generation,
          );
        }
        // All concurrent callers await this same promise. Preserve its
        // outcome independently of whether their own handler was entered.
        if (
          error instanceof ExecutionRefused ||
          error instanceof ExecutionProblem
        )
          throw error;
        throw new ExecutionProblem(
          error instanceof Problem ? error.status : 500,
          error instanceof Problem
            ? error.message
            : "Execution request could not be completed. Inspect its current state before retrying.",
          "unknown",
        );
      },
    )
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}
