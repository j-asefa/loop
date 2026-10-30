/** CLI side of the connection service: find, start, converge on and stop it. */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { copyFile, chmod, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateDir } from "./state.js";
import {
  CONNECTION_PROTOCOL,
  CONNECTION_RECORD,
  connectionControl,
  inspectConnection,
  sameMode,
  type ConnectionRecord,
  type Hello,
  type TunnelMode,
} from "./connection.js";
import {
  exited,
  recordedChildren,
  retireLog,
  terminateWorkspace,
} from "./daemon.js";

const testWait = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/**
 * The service runs from an immutable copy of its single-file bundle, so npm
 * replacing the package during an upgrade cannot remove code it still needs.
 * Source checkouts (development and tests) run the TypeScript entry directly.
 */
async function serviceEntry(dir: string) {
  const here = fileURLToPath(import.meta.url);
  const bundle = fileURLToPath(
    new URL("./connection-daemon.bundle.mjs", import.meta.url),
  );
  if (extname(here) === ".js" && existsSync(bundle)) {
    const bytes = readFileSync(bundle);
    const digest = createHash("sha256")
      .update(bytes)
      .digest("hex")
      .slice(0, 16);
    const bin = join(dir, "bin");
    privateDir(bin);
    const target = join(bin, `connection-${digest}.mjs`);
    if (!existsSync(target)) {
      const temp = `${target}.${randomUUID()}.tmp`;
      await copyFile(bundle, temp);
      await chmod(temp, 0o500);
      await rename(temp, target);
    }
    return { args: [target] };
  }
  return {
    args: [
      ...process.execArgv,
      fileURLToPath(
        new URL("./connection-daemon" + extname(here), import.meta.url),
      ),
    ],
  };
}

export function tunnelArgs(mode: TunnelMode) {
  return mode.kind === "named"
    ? [
        "--tunnel-name",
        mode.name,
        "--public-url",
        mode.origin,
        ...(mode.config ? ["--tunnel-config", mode.config] : []),
      ]
    : [];
}

/** Starts one detached service in its own process group and waits for its tunnel. */
async function spawnConnection(
  root: string,
  dir: string,
  mode: TunnelMode,
  release: string,
) {
  privateDir(dir);
  const log = join(dir, "daemon.log");
  await retireLog(log);
  const entry = await serviceEntry(dir);
  const fd = openSync(log, "a", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(
      process.execPath,
      [
        ...entry.args,
        "--dir",
        dir,
        "--root",
        root,
        "--release",
        release,
        "--log",
        ...tunnelArgs(mode),
      ],
      // Detached: neither the application's process group nor its forced
      // stop includes the service, so an application restart keeps it.
      { detached: true, stdio: ["ignore", fd, fd, "ipc"], cwd: dir },
    );
  } finally {
    closeSync(fd);
  }
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          // Its shutdown stops the cloudflared it started; nothing is left behind.
          child.kill("SIGTERM");
          reject(new Error("The tunnel did not start in time. See " + log));
        },
        testWait("LOOP55_TEST_CONNECTION_START_MS", 120000),
      );
      child.once("message", (m: any) => {
        clearTimeout(timer);
        if (m?.ready) resolve(m.origin);
        else
          reject(new Error(m?.error || "Connection service failed to start."));
      });
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(
            `Connection service exited during startup${code ? ` (code ${code})` : ""}. See ${log}.`,
          ),
        );
      });
    });
  } finally {
    child.removeAllListeners();
    if (child.connected) child.disconnect();
    child.unref();
  }
}

export type Connection = {
  record: ConnectionRecord;
  hello: Hello;
  created: boolean;
};

/**
 * Reuses this workspace's verified, compatible service or starts exactly one.
 * With `external`, a service manager or sibling container owns it, and this
 * only waits for it to become ready.
 */
export async function ensureConnection(options: {
  root: string;
  dir: string;
  mode: TunnelMode;
  release: string;
  external: boolean;
  log?: (message: string) => void;
}): Promise<Connection> {
  const { root, dir, mode, release, external } = options;
  const deadline =
    Date.now() + testWait("LOOP55_TEST_CONNECTION_WAIT_MS", 180000);
  let created = false;
  let waiting = "";
  for (;;) {
    const found = await inspectConnection(dir);
    let reason = "";
    if (found.state === "running") {
      if (found.hello.protocol !== CONNECTION_PROTOCOL)
        throw new Error(
          `The running connection service speaks protocol ${found.hello.protocol}; this Loop55 needs ${CONNECTION_PROTOCOL}. Run loop55 stop, then loop55 start to replace it (the Quick Tunnel address will change once).`,
        );
      if (!sameMode(found.record.mode, mode))
        throw new Error(
          "The running connection service uses different tunnel settings. Run loop55 stop first; the public address may change.",
        );
      if (found.hello.tunnel.state === "ready" && found.hello.origin)
        return { record: found.record, hello: found.hello, created };
      reason = "Waiting for the tunnel to reconnect…";
    } else if (found.state === "unknown")
      throw new Error(
        `The connection service record names process ${found.record.pid}, which Loop55 can't confirm. Check it with ps; run loop55 stop once it is gone.`,
      );
    else if (found.state === "unresponsive" && !external)
      throw new Error(
        found.local
          ? `Connection service process ${found.record.pid} is not responding. Run loop55 stop to end it (the public address will change), then start again.`
          : "The connection service belongs to another container and is not responding. Restart that container.",
      );
    else if (external) reason = "Waiting for the connection service…";
    else if (created)
      throw new Error(
        "The connection service exited after starting. See loop55 logs.",
      );
    else {
      if (found.state === "exited") await clearStaleConnection(dir);
      try {
        await spawnConnection(root, dir, mode, release);
        created = true;
        continue;
      } catch (error) {
        // A concurrent start may own the lock; converge on that service.
        if (!/starting or running/.test((error as Error).message)) throw error;
      }
    }
    if (reason && reason !== waiting) options.log?.((waiting = reason));
    if (Date.now() > deadline)
      throw new Error(
        external
          ? "The connection service did not become ready. Check its service manager or container."
          : "The connection service did not become ready. See loop55 logs.",
      );
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** A crashed service may leave its cloudflared behind; stop only recorded, confirmed processes. */
async function clearStaleConnection(dir: string) {
  const { unresolved, survivors } = await terminateWorkspace(
    dir,
    undefined,
    testWait("LOOP55_TEST_STOP_GRACE_MS", 5000),
  );
  if (survivors.length || unresolved.length)
    throw new Error(
      `A previous connection service left process(es) ${[...survivors, ...unresolved.map((r) => r.pid)].join(", ")} that Loop55 can't stop safely. Check them with ps, then retry.`,
    );
  await Promise.all(
    [CONNECTION_RECORD, "children.json", "stop-records.json"].map((f) =>
      rm(join(dir, f), { force: true }),
    ),
  );
}

/**
 * Full shutdown of this computer's connection service and its cloudflared.
 * Returns false when there was nothing to stop, "external" when another
 * container owns it.
 */
export async function stopConnection(
  dir: string,
): Promise<boolean | "external"> {
  if (!existsSync(dir)) return false;
  const found = await inspectConnection(dir);
  if (found.state === "absent") {
    if (!(await recordedChildren(dir)).length) return false;
    await clearStaleConnection(dir);
    return true;
  }
  if (!found.local) return "external";
  if (found.state === "unknown")
    throw new Error(
      `Connection service process ${found.record.pid} can't be confirmed as Loop55's, so it was left running. Check it with ps, then run loop55 stop again.`,
    );
  if (found.state === "running") {
    await connectionControl(found.record, "shutdown").catch(() => {});
    if (
      await exited(
        found.record.pid,
        testWait("LOOP55_TEST_STOP_WAIT_MS", 15000),
      )
    ) {
      await clearStaleConnection(dir);
      return true;
    }
  }
  if (found.state !== "exited") {
    const { unresolved, survivors } = await terminateWorkspace(
      dir,
      { pid: found.record.pid, identity: found.record.identity },
      testWait("LOOP55_TEST_STOP_GRACE_MS", 5000),
    );
    if (survivors.length || unresolved.length)
      throw new Error(
        `Connection service process(es) ${[...survivors, ...unresolved.map((r) => r.pid)].join(", ")} did not stop. Its record was kept; check them with ps.`,
      );
  }
  await clearStaleConnection(dir);
  return true;
}
