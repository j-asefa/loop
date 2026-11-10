import { spawnHarnessProcess } from "./native-spawn.js";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, delimiter, resolve } from "node:path";
import { request } from "node:http";
import { harnesses, type Harness } from "./shared/harnesses.js";
import { killOwned } from "./processes.js";
const versionProbes = new Map<string, Promise<string>>();

// Settings, sign-in and installation checks can request the same executable
// concurrently. Share only the in-flight read; a later check observes upgrades.
function versionOutput(name: Harness, executable: string) {
  const key = name + "\0" + executable;
  const existing = versionProbes.get(key);
  if (existing) return existing;
  const probe = new Promise<string>((resolve, reject) => {
    const child = spawnHarnessProcess(executable, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...harnesses[name].environment,
      },
    });
    // A launcher can exit while its child keeps the output pipes open. Stop
    // the owned group on exit and at the deadline, not just the launcher PID.
    const stop = () => killOwned(child, "SIGKILL");
    let failure: Error | undefined;
    let bytes = 0;
    const output: Buffer[] = [];
    const fail = (error: Error) => {
      failure ??= error;
      stop();
    };
    const deadline = setTimeout(
      () => fail(new Error("Version probe timed out")),
      10000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 20000) fail(new Error("Version probe output is too large"));
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 20000) fail(new Error("Version probe output is too large"));
    });
    child.once("error", fail);
    child.once("exit", stop);
    child.once("close", (code) => {
      clearTimeout(deadline);
      stop();
      if (failure || code !== 0)
        reject(failure ?? new Error("Version probe failed"));
      else resolve(Buffer.concat(output).toString("utf8"));
    });
  }).finally(() => {
    if (versionProbes.get(key) === probe) versionProbes.delete(key);
  });
  versionProbes.set(key, probe);
  return probe;
}
function meetsMinimum(version: string | undefined, minimum: string) {
  if (!version) return false;
  const core = version.split("+")[0];
  // Keep prerelease identifiers: stripping them would silently admit betas.
  if (core.includes("-")) return false;
  const parts = core.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  const floor = minimum.split(".").map(Number);
  for (let i = 0; i < floor.length; i++) {
    if (parts[i] !== floor[i]) return parts[i] > floor[i];
  }
  return true;
}

export async function discover(name: Harness, explicit?: string) {
  if (name === "acp")
    throw new Error("Use loop acp --executable with an absolute path.");
  let executable: string | undefined;
  for (const candidate of explicit
    ? [resolve(explicit)]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .map((p) => join(p, harnesses[name].executable))) {
    try {
      await access(candidate, constants.X_OK);
      executable = resolve(candidate);
      break;
    } catch {
      /* next PATH entry */
    }
  }
  if (!executable)
    return {
      name,
      installed: false as const,
      help: harnesses[name].installUrl,
    };
  try {
    const stdout = await versionOutput(name, executable);
    const version = stdout.match(
      /(?:^|\s)v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?=\s|$)/,
    )?.[1];
    const supported = meetsMinimum(version, harnesses[name].minimumVersion);
    return {
      name,
      installed: true as const,
      executable,
      version,
      supported,
      help: supported
        ? ""
        : `Requires a stable ${name} version >= ${harnesses[name].minimumVersion}. ${version ? `Found ${version}.` : "Could not read its version."} Install/check it at ${harnesses[name].installUrl}.`,
    };
  } catch {
    return {
      name,
      installed: true as const,
      executable,
      supported: false,
      help: "Executable failed --version; check installation.",
    };
  }
}
export async function control(
  dir: string,
  action: string,
  data: unknown = {},
): Promise<any> {
  const config = JSON.parse(await readFile(join(dir, "control.json"), "utf8"));
  if (
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535 ||
    typeof config.token !== "string"
  )
    throw new Error("Invalid local host record");
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: config.port,
        path: "/" + action,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + config.token,
        },
        timeout: action === "enable" ? 60000 : 3000,
      },
      (res) => {
        let out = "";
        res.on("data", (b) => {
          out += b;
          if (out.length > 1000000) req.destroy();
        });
        res.on("end", () => {
          try {
            const value = JSON.parse(out);
            res.statusCode === 200
              ? resolve(value)
              : reject(new Error(value.error ?? "Control failed"));
          } catch {
            reject(new Error("Invalid host response"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Host did not respond")));
    req.on("error", reject);
    req.end(JSON.stringify(data));
  });
}
