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
  const rows = db
    .prepare(
      "SELECT command_id,length(CAST(result AS BLOB)) bytes FROM execution_commands WHERE owner_id=? AND result IS NOT NULL ORDER BY (command_id=?) DESC,updated_at DESC,command_id DESC",
    )
    .all(owner, current) as { command_id: string; bytes: number }[];
  let count = 0,
    bytes = 0;
  const compact = db.prepare(
    "UPDATE execution_commands SET result=NULL WHERE owner_id=? AND command_id=? AND state='completed'",
  );
  for (const row of rows) {
    if (++count <= 64 && bytes + row.bytes <= 4 * 1024 * 1024)
      bytes += row.bytes;
    else compact.run(owner, row.command_id);
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
      const row = db
        .prepare(
          "SELECT method,digest,generation,state,result FROM execution_commands WHERE owner_id=? AND command_id=?",
        )
        .get(request.owner, commandId) as Receipt | undefined;
      if (row) return row;
      db.prepare(
        "INSERT INTO execution_commands(owner_id,command_id,method,digest,generation,state,created_at,updated_at) VALUES(?,?,?,?,?,'started',?,?)",
      ).run(
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
          db.prepare(
            "UPDATE execution_commands SET state='completed',result=?,updated_at=? WHERE owner_id=? AND command_id=? AND generation=? AND state='started'",
          ).run(
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
          db.prepare(
            "DELETE FROM execution_commands WHERE owner_id=? AND command_id=? AND generation=? AND state='started'",
          ).run(request.owner, commandId, request.generation);
        } else {
          db.prepare(
            "UPDATE execution_commands SET state='unknown',updated_at=? WHERE owner_id=? AND command_id=? AND generation=? AND state='started'",
          ).run(now(), request.owner, commandId, request.generation);
        }
        throw error;
      },
    )
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}
