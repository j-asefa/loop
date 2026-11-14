import type { ChildProcess } from "node:child_process";
import { harnesses, isHarness, type CliSignIn } from "../shared/harnesses.js";
import type { AuthDriver } from "./types.js";
import type { AuthOptions } from "./types.js";
import { spawnHarnessProcess, stopHarnessProcess } from "../native-spawn.js";

// Codex and Grok Build print a device-code URL and code; Claude Code prints a
// URL and reads a pasted code. Credentials stay in each CLI's own store.
export function cliDriver(options: AuthOptions): AuthDriver {
  let child: ChildProcess | undefined;
  const descriptor = isHarness(options.name)
    ? harnesses[options.name]
    : undefined;
  const signIn: CliSignIn | null | undefined = descriptor?.cliSignIn;
  if (!signIn) throw new Error("Unsupported CLI sign-in harness");
  const response = signIn.response;
  const device = response.kind === "device-code";
  return {
    async providers() {
      return [
        {
          ...signIn.provider,
          methods: signIn.methods.map(({ id, type, label }) => ({
            id,
            type,
            label,
          })),
        },
      ];
    },
    async login(_provider, method, io) {
      await stopHarnessProcess(child);
      const process = (child = spawnHarnessProcess(
        options.executable,
        [
          ...(signIn.methods.find((entry) => entry.id === method)?.args ??
            signIn.defaultArgs),
        ],
        {
          cwd: options.project,
          env: {
            ...(options.env ?? globalThis.process.env),
            BROWSER: "false",
            DISABLE_AUTOUPDATER: "1",
            ...descriptor!.environment,
          },
          stdio: "pipe",
        },
      ));
      await new Promise<void>((resolve, reject) => {
        let output = "",
          asked = false;
        const abort = () => {
          void stopHarnessProcess(process);
          reject(new Error("Sign-in cancelled"));
        };
        io.signal.addEventListener("abort", abort, { once: true });
        const consume = (chunk: Buffer) => {
          try {
            if (io.signal.aborted) return;
            output = (output + chunk.toString())
              .replace(/\x1b\[[0-9;]*m/g, "")
              .slice(-20000);
            const url = (
              output.match(/https:\/\/[^\s<>"']+(?=[\s<>"'])/g) || []
            ).find((value) => {
              try {
                const parsed = new URL(value);
                return (
                  !parsed.username &&
                  !parsed.password &&
                  signIn.domains.some(
                    ({ name, subdomains }) =>
                      parsed.hostname === name ||
                      (subdomains && parsed.hostname.endsWith("." + name)),
                  )
                );
              } catch {
                return false;
              }
            });
            if (url)
              io.link(
                url,
                device
                  ? output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)?.[0]
                  : undefined,
              );
            if (
              url &&
              !asked &&
              /(?:paste|enter)[^\n]*code/i.test(output) &&
              response.kind === "manual-code"
            ) {
              asked = true;
              void io
                .prompt({
                  type: "manual_code",
                  message: response.prompt,
                })
                .then(
                  (value) => {
                    if (!io.signal.aborted) process.stdin?.write(value + "\n");
                  },
                  () => {},
                );
            }
          } catch {
            void stopHarnessProcess(process);
            reject(new Error("Unsupported sign-in response"));
          }
        };
        process.stdout!.on("data", consume);
        process.stderr!.on("data", consume);
        process.stdin!.on("error", () => {});
        process.once("error", () => {
          io.signal.removeEventListener("abort", abort);
          reject(new Error("Sign-in process failed"));
        });
        process.once("exit", (code) => {
          output = "";
          io.signal.removeEventListener("abort", abort);
          code === 0 ? resolve() : reject(new Error("Sign-in failed"));
        });
        if (io.signal.aborted) abort();
      });
    },
    async dispose() {
      await stopHarnessProcess(child);
    },
  };
}
