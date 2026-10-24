import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, delimiter, resolve } from "node:path";
import { request } from "node:http";
import type { Harness } from "./protocol.js";
const exec = promisify(execFile);
// Floors for the adapter protocols we require, not exact release pins. New
// stable releases are admitted; adapter startup still checks the live protocol
// and authentication/billing contract before dispatching a prompt.
const minimumVersions = {
  codex: "0.157.0",
  claude: "2.1.237",
  pi: "0.87.1",
  opencode: "1.18.32",
  gemini: "0.64.0",
  // Account sign-in and login methods on the experimental MSP surface.
  muse: "1.4.12",
};
const install = {
  codex: "https://developers.openai.com/codex/cli",
  claude: "https://code.claude.com/docs/en/setup",
  pi: "https://github.com/earendil-works/pi",
  opencode: "https://opencode.ai/docs",
  gemini: "https://geminicli.com/docs/get-started/installation/",
  muse: "https://dev.meta.ai/docs/muse-code/",
};

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
    : (process.env.PATH ?? "").split(delimiter).map((p) => join(p, name))) {
    try {
      await access(candidate, constants.X_OK);
      executable = resolve(candidate);
      break;
    } catch {
      /* next PATH entry */
    }
  }
  if (!executable)
    return { name, installed: false as const, help: install[name] };
  try {
    const { stdout } = await exec(executable, ["--version"], {
      timeout: 10000,
      maxBuffer: 20000,
    });
    const version = stdout.match(
      /(?:^|\s)v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?=\s|$)/,
    )?.[1];
    const supported = meetsMinimum(version, minimumVersions[name]);
    return {
      name,
      installed: true as const,
      executable,
      version,
      supported,
      help: supported
        ? ""
        : `Requires a stable ${name} version >= ${minimumVersions[name]}. ${version ? `Found ${version}.` : "Could not read its version."} Install/check it at ${install[name]}.`,
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
