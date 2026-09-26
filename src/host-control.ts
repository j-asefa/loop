import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { access, realpath, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, delimiter, resolve } from "node:path";
import { request } from "node:http";
import type { Harness } from "./protocol.js";
const exec = promisify(execFile);
const releases = {
  codex: "0.157.0",
  claude: "2.1.282",
  pi: "0.87.1",
  opencode: "1.18.32",
};
const install = {
  codex: "https://developers.openai.com/codex/cli",
  claude: "https://code.claude.com/docs/en/setup",
  pi: "https://github.com/earendil-works/pi",
  opencode: "https://opencode.ai/docs",
};

export async function discover(name: Harness, explicit?: string) {
  let executable: string | undefined;
  for (const candidate of explicit
    ? [resolve(explicit)]
    : (process.env.PATH ?? "").split(delimiter).map((p) => join(p, name))) {
    try {
      await access(candidate, constants.X_OK);
      executable = await realpath(candidate);
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
    const version = stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0];
    const supported = version === releases[name];
    return {
      name,
      installed: true as const,
      executable,
      version,
      supported,
      help: supported
        ? ""
        : `Validated version: ${releases[name]}. Install/check it at ${install[name]}; Loop never upgrades your harness.`,
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
