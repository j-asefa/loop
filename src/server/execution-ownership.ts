import {
  PROCESS_FILES,
  identity,
  pidNamespace,
  terminateWorkspace,
  forgetWorkspace,
  recordedGroupAlive,
  processState,
} from "../process-records.js";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { atomic, privateDir } from "../state.js";

const Owner = z.strictObject({
  pid: z.number().int().min(2),
  identity: z.string().min(1),
  namespace: z.string().min(1),
  namespaceIdentity: z.string().min(1),
  generation: z.string().uuid(),
});
export type ExecutionOwnership = {
  generation: string;
  directory: string;
  assertCurrent(expected?: string): void;
  release(): void;
};
let current: ExecutionOwnership | undefined;
let installed = false;
function executionNamespace() {
  if (process.platform === "darwin") {
    try {
      // A boot-session UUID distinguishes another Mac or a reboot without
      // relying on a hostname or on files copied with the workspace.
      const boot = execFileSync(
        "/usr/sbin/sysctl",
        ["-n", "kern.bootsessionuuid"],
        {
          encoding: "utf8",
          timeout: 3000,
          maxBuffer: 1024,
          stdio: ["ignore", "pipe", "ignore"],
        },
      )
        .trim()
        .toLowerCase();
      return {
        namespace: "darwin",
        namespaceIdentity: z.string().uuid().parse(boot),
      };
    } catch {
      throw new Error("Could not establish execution host boot identity.");
    }
  }
  const namespace = pidNamespace();
  // Namespace inode numbers can be reused after a container stops. Include
  // that namespace's init identity, not just its /proc namespace link.
  const namespaceIdentity = namespace ? identity(1) : undefined;
  if (!namespace || !namespaceIdentity)
    throw new Error("Could not establish execution PID namespace identity.");
  return { namespace, namespaceIdentity };
}
function sameNamespace(
  owner: z.infer<typeof Owner>,
  location = executionNamespace(),
) {
  return (
    owner.namespace === location.namespace &&
    owner.namespaceIdentity === location.namespaceIdentity
  );
}
const foreignNamespace = () =>
  new Error(
    "The prior execution worker belongs to another PID namespace lifetime after a container restart, host reboot, or moved workspace. After confirming the prior host/container and all its processes stopped, inspect loop recover-execution. No runs were recovered.",
  );
/** Local stop must never interpret another namespace's PIDs as its own. */
export function assertExecutionNamespace(data: string) {
  const owner = recordedExecutionOwner(data);
  if (owner && !sameNamespace(owner)) throw foreignNamespace();
}
export function executionGeneration() {
  return current?.generation;
}
export function assertExecutionGeneration(expected?: string) {
  if (installed && !current) throw new Error("Execution ownership has ended.");
  current?.assertCurrent(expected);
}

function lockDirectory(directory: string, lockWaitMs = 0) {
  privateDir(directory);
  const lock = new Database(join(directory, "ownership.sqlite"), {
    timeout: lockWaitMs,
  });
  try {
    lock.pragma("journal_mode = DELETE");
    lock.exec("BEGIN EXCLUSIVE");
    return lock;
  } catch {
    lock.close();
    throw new Error(
      "Another execution worker holds the workspace lock. Execution ownership was not acquired.",
    );
  }
}
export function recordedExecutionOwner(data: string) {
  try {
    return Owner.parse(
      JSON.parse(
        readFileSync(
          join(data, PROCESS_FILES.execution, PROCESS_FILES.executionOwner),
          "utf8",
        ),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(
        "Execution ownership is unreadable. Preserve the workspace and inspect execution/owner.json.",
      );
  }
}

/** Explicit offline recovery: a PID namespace outside this process's view
 * needs the operator's confirmation that its host/container and all children have
 * stopped. The generation binds that assertion to the inspected record. */
export function recoverStoppedExecution(
  data: string,
  stoppedGeneration: string,
) {
  const generation = z.string().uuid().parse(stoppedGeneration);
  const directory = join(data, PROCESS_FILES.execution),
    lock = lockDirectory(directory);
  try {
    const owner = recordedExecutionOwner(data);
    if (!owner || owner.generation !== generation)
      throw new Error(
        "Execution generation changed or is absent. Inspect loop recover-execution again; no records were retired.",
      );
    const location = executionNamespace();
    if (sameNamespace(owner, location))
      throw new Error(
        "This recovery is only for a stopped foreign PID namespace lifetime. Use loop stop for processes in this same namespace lifetime.",
      );
    const archive = join(directory, `retired-${generation}-${randomUUID()}`);
    privateDir(archive);
    // Keep the blocking owner until every child record has been archived. An
    // interrupted recovery remains blocked and can repeat the same assertion.
    for (const name of [
      PROCESS_FILES.children,
      PROCESS_FILES.stop,
      PROCESS_FILES.executionOwner,
    ]) {
      try {
        renameSync(join(directory, name), join(archive, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return archive;
  } finally {
    lock.close();
  }
}

// Call only while holding the execution lock. A lock alone is insufficient:
// detached children may outlive its previous holder.
async function confirmStoppedExecution(data: string, directory: string) {
  const prior = recordedExecutionOwner(data);
  const location = executionNamespace();
  if (prior && !sameNamespace(prior, location)) throw foreignNamespace();
  if (prior && (processState(prior) !== "exited" || recordedGroupAlive(prior)))
    throw new Error(
      "The prior execution worker cannot be confirmed stopped. No runs were recovered.",
    );
  // Corrupt registries are uncertainty, never evidence that no children
  // remain. Keep them for inspection rather than overwriting them at boot.
  for (const name of [PROCESS_FILES.children, PROCESS_FILES.stop]) {
    try {
      z.array(
        z.object({ pid: z.number().int().min(2), identity: z.string() }),
      ).parse(JSON.parse(readFileSync(join(directory, name), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "Execution child records are unreadable. Preserve them and inspect before restarting.",
        );
    }
  }
  const cleanup = await terminateWorkspace(directory, undefined, 1000);
  if (cleanup.unresolved.length || cleanup.survivors.length)
    throw new Error(
      "Prior native processes cannot be confirmed stopped. Run loop stop and inspect the retained execution process records before retrying.",
    );
  return location;
}

/** Retire stopped ownership without installing a fictitious execution owner.
 * Keep the prior owner until all cleanup and final validation succeed. */
export async function retireStoppedExecution(
  data: string,
  options: {
    lockWaitMs?: number;
    cleanupWorkspace?: () => Promise<void>;
  } = {},
) {
  const directory = join(data, PROCESS_FILES.execution),
    lock = lockDirectory(directory, options.lockWaitMs);
  try {
    await confirmStoppedExecution(data, directory);
    await options.cleanupWorkspace?.();
    await forgetWorkspace(directory);
    try {
      unlinkSync(join(directory, PROCESS_FILES.executionOwner));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } finally {
    lock.close();
  }
}

/** A separate rollback-mode SQLite file holds an OS exclusive lock for the
 * entire worker lifetime. Never unlink it, expire it, or use the application
 * database for this transaction. A paused process keeps its ownership. */
export async function acquireExecutionOwnership(
  data: string,
  options: { lockWaitMs?: number } = {},
): Promise<ExecutionOwnership> {
  const directory = join(data, PROCESS_FILES.execution);
  const lock = lockDirectory(directory, options.lockWaitMs);
  try {
    const path = join(directory, PROCESS_FILES.executionOwner);
    const location = await confirmStoppedExecution(data, directory);
    // Retire confirmed records before installing the next generation, so
    // crash replacement cannot accumulate stale process IDs indefinitely.
    await forgetWorkspace(directory);
    const owner = Owner.parse({
      pid: process.pid,
      identity: identity(process.pid),
      ...location,
      generation: randomUUID(),
    });
    atomic(path, owner);
    let held = true;
    const ownership: ExecutionOwnership = {
      directory,
      generation: owner.generation,
      assertCurrent(expected = owner.generation) {
        if (!held || expected !== owner.generation || !lock.inTransaction)
          throw new Error("Execution worker generation is no longer current.");
        const recorded = Owner.parse(JSON.parse(readFileSync(path, "utf8")));
        if (
          recorded.generation !== owner.generation ||
          recorded.pid !== process.pid ||
          recorded.identity !== owner.identity
        )
          throw new Error("Execution worker ownership changed.");
      },
      release() {
        held = false;
        if (current === ownership) current = undefined;
        lock.close();
      },
    };
    current = ownership;
    installed = true;
    return ownership;
  } catch (error) {
    lock.close();
    throw error;
  }
}
