import { opencodeSignInEnvironment } from "./runner-environment.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { killOwned, own } from "../processes.js";
import {
  inspectOpencodeNativeAuth,
  inspectOpencodeCatalog,
  opencodeSubscriptionEnvironment,
} from "./account-policy.js";

type NativeOptions = {
  executable: string;
  project: string;
  env: NodeJS.ProcessEnv;
};

/** Host-resolved executable only. No prompt/session is created during discovery. */
export async function discoverOpencode(options: NativeOptions) {
  const status = inspectOpencodeNativeAuth(options.env);
  if (!status.authenticated) return status;
  try {
    return await withOpencode(options, async (endpoint, headers) => {
      const models = await inspectOpencodeCatalog(
        endpoint,
        options.project,
        headers,
      );
      const current = inspectOpencodeNativeAuth(options.env);
      if (!current.authenticated) return current;
      return {
        ...current,
        models,
        executionGuard: "loop-subscription-v1" as const,
      };
    });
  } catch {
    throw new Error(
      "OpenCode model discovery could not verify subscription configuration",
    );
  }
}

/** Delete only the managed OpenAI provider through the native credential API. */
export async function logoutOpencode(options: NativeOptions) {
  try {
    await withOpencode(
      options,
      async (endpoint, headers) => {
        const response = await fetch(`${endpoint}/auth/openai`, {
          method: "DELETE",
          headers,
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok || (await response.json()) !== true)
          throw new Error("Native sign-out refused");
      },
      opencodeSignInEnvironment(options.env),
    );
  } catch {
    throw new Error("OpenCode sign-out could not be completed");
  }
}

async function withOpencode<T>(
  options: NativeOptions,
  operation: (endpoint: string, headers: Record<string, string>) => Promise<T>,
  processEnvironment?: NodeJS.ProcessEnv,
): Promise<T> {
  if (!isAbsolute(options.executable) || !isAbsolute(options.project))
    throw new Error("OpenCode discovery requires host-resolved paths");
  const password = randomBytes(32).toString("hex");
  const child = spawn(
    options.executable,
    ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    {
      cwd: options.project,
      env: {
        ...(processEnvironment ?? opencodeSubscriptionEnvironment(options.env)),
        OPENCODE_SERVER_USERNAME: "opencode",
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_DISABLE_MODELS_FETCH: "1",
      },
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  own(child);
  let stopped = false;
  const exited = new Promise<void>((resolve) => {
    child.once("error", () => {
      stopped = true;
      resolve();
    });
    child.once("exit", () => {
      stopped = true;
      resolve();
    });
  });
  const deadline = setTimeout(() => killOwned(child, "SIGKILL"), 25000);
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = "";
      child.stdout!.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-4096);
        const match = output.match(
          /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)\r?\n/,
        );
        if (match) resolve(match[1]);
      });
      void exited.then(() =>
        reject(new Error("OpenCode discovery unavailable")),
      );
    });
    const result = await operation(endpoint, {
      Authorization:
        "Basic " + Buffer.from("opencode:" + password).toString("base64"),
    });
    if (stopped) throw new Error("OpenCode process unavailable");
    return result;
  } finally {
    clearTimeout(deadline);
    killOwned(child, "SIGTERM");
    await Promise.race([exited, delay(1000)]);
    // Also remove descendants if the parent exited first.
    killOwned(child, "SIGKILL");
    await exited;
  }
}
