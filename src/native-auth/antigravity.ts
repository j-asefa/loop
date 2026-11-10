import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { own } from "../processes.js";
import type { AuthDriver } from "./types.js";
import type { AuthOptions } from "./types.js";
import { stop } from "./process.js";

// agy has no login command; its terminal UI signs in. Run it under script(1)
// for a terminal wide enough to print Google's URL on one line, choose Google
// OAuth and type back the code that antigravity.google shows. agy stores the
// credential; `agy models`, the adapter's own sign-in check, confirms it.
let antigravityExchangeWait = 90000;
let antigravityStartWait = 30000;
export function setAntigravityExchangeWait(ms: number) {
  antigravityExchangeWait = ms;
}
export function setAntigravityStartWait(ms: number) {
  antigravityStartWait = ms;
}
export function antigravityDriver(options: AuthOptions): AuthDriver {
  let child: ChildProcess | undefined;
  const env = {
    ...(options.env ?? process.env),
    BROWSER: "false",
    // script(1) runs the command with $SHELL; keep its syntax predictable.
    SHELL: "/bin/sh",
    TERM: (options.env ?? process.env).TERM || "xterm-256color",
    LOOP_AGY: options.executable,
  };
  // Sign-in checks end with their attempt, never overlapping the next one.
  const checks = new Set<ChildProcess>();
  const stopAll = () =>
    Promise.all([stop(child), ...[...checks].map((check) => stop(check))]);
  const signedIn = () =>
    new Promise<boolean>((resolve) => {
      const check = spawn(options.executable, ["models"], {
        cwd: options.project,
        env: options.env ?? process.env,
        stdio: "ignore",
        detached: true,
      });
      own(check);
      checks.add(check);
      const timer = setTimeout(() => void stop(check), 20000);
      check.once("error", () => {
        checks.delete(check);
        resolve(false);
      });
      check.once("exit", (code) => {
        checks.delete(check);
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  return {
    async providers() {
      return [
        {
          id: "google",
          name: "Google",
          methods: [
            { id: "oauth", type: "oauth", label: "Sign in with Google" },
          ],
        },
      ];
    },
    async login(_provider, _method, io) {
      await stopAll();
      // A signed-in agy opens its chat screen instead of the sign-in menu.
      if (await signedIn()) return;
      if (io.signal.aborted) throw new Error("Sign-in cancelled");
      const shell = 'stty cols 4000 rows 200 2>/dev/null; exec "$LOOP_AGY"';
      const process = (child = spawn(
        "script",
        globalThis.process.platform === "darwin"
          ? ["-q", "/dev/null", "/bin/sh", "-c", shell]
          : ["-qfec", shell, "/dev/null"],
        { cwd: options.project, env, stdio: "pipe", detached: true },
      ));
      own(process);
      try {
        await new Promise<void>((resolve, reject) => {
          let output = "",
            phase: "menu" | "link" | "code" | "exchange" = "menu",
            timer: ReturnType<typeof setTimeout> | undefined,
            done = false;
          const finish = (error?: Error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            io.signal.removeEventListener("abort", abort);
            error ? reject(error) : resolve();
          };
          const abort = () => finish(new Error("Sign-in cancelled"));
          io.signal.addEventListener("abort", abort, { once: true });
          const confirm = async () => {
            while (!done && phase === "exchange") {
              if (await signedIn()) return finish();
              await new Promise((wait) => setTimeout(wait, 1500));
            }
          };
          process.stdout!.on("data", (chunk: Buffer) => {
            if (done) return;
            output = (output + chunk.toString())
              .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
              .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
              .slice(-40000);
            // Wait for the highlighted choice; the menu can arrive in chunks.
            const choice =
              phase === "menu" && /Select login method/.test(output)
                ? output.match(/>\s*1\.\s*([^\n]*?)\s*\n\s*2\./)?.[1]
                : undefined;
            if (choice) {
              // Only the default first choice is accepted: Google OAuth.
              if (!/^Google OAuth$/.test(choice))
                return finish(new Error("Unsupported sign-in response"));
              phase = "link";
              output = "";
              process.stdin!.write("\r");
            } else if (
              phase === "link" &&
              /paste the authorization code/i.test(output)
            ) {
              const url = (output.match(/https:\/\/[^\s<>"']+/g) || []).find(
                (value) => {
                  try {
                    const parsed = new URL(value);
                    return (
                      parsed.hostname === "accounts.google.com" &&
                      !parsed.username &&
                      !parsed.password
                    );
                  } catch {
                    return false;
                  }
                },
              );
              if (!url)
                return finish(new Error("Unsupported sign-in response"));
              phase = "code";
              // The person now has the link; the shared expiry covers them.
              clearTimeout(timer);
              try {
                io.link(url);
              } catch {
                return finish(new Error("Unsupported sign-in response"));
              }
              void io
                .prompt({
                  type: "manual_code",
                  message: "Paste the authorization code from Antigravity",
                })
                .then(
                  (value) => {
                    if (done) return;
                    phase = "exchange";
                    output = "";
                    // One line of printable characters: no terminal controls.
                    process.stdin!.write(
                      value.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, "") + "\r",
                    );
                    timer = setTimeout(
                      () => finish(new Error("Sign-in timed out")),
                      antigravityExchangeWait,
                    );
                    void confirm();
                  },
                  () => {},
                );
            } else if (phase === "exchange" && /Got an error/.test(output))
              finish(new Error("Sign-in failed"));
          });
          process.stderr!.resume();
          process.stdin!.on("error", () => {});
          process.once("error", () =>
            finish(new Error("Sign-in process failed")),
          );
          // agy may exit once it saves the credential; let agy models decide.
          process.once("exit", () => {
            if (done) return;
            if (phase !== "exchange")
              return finish(new Error("Sign-in failed"));
            void signedIn().then((ok) =>
              finish(ok ? undefined : new Error("Sign-in failed")),
            );
          });
          // An agy that stalls before its link ends the attempt.
          timer = setTimeout(
            () => finish(new Error("Sign-in timed out")),
            antigravityStartWait,
          );
          if (io.signal.aborted) abort();
        });
      } finally {
        await stopAll();
      }
    },
    async dispose() {
      await stopAll();
    },
  };
}
