import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { CodexSession } from "./codex-session.mjs";
import {
  RuntimeFailure,
  diagnosticText,
  runtimeFailureFacts,
} from "./diagnostics.ts";
import { HarnessError } from "./harness.ts";
import { redactValues } from "./redaction.ts";

const hostMode = process.env.LOOP_RUNTIME_MODE === "host";
const env = hostMode
  ? { ...process.env }
  : {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CODEX_HOME: `${process.env.HOME}/.codex`,
      TERM: "dumb",
      NO_COLOR: "1",
    };
for (const key of [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "LOOP_RUNTIME_TOKEN",
  "LOOP_RUNTIME_TOKEN_FILE",
])
  delete env[key];
if (!hostMode) mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });
const child = spawn(
  "codex",
  [
    "app-server",
    "--stdio",
    "-c",
    'forced_login_method="chatgpt"',
    ...(!hostMode ? ["-c", 'cli_auth_credentials_store="file"'] : []),
  ],
  {
    cwd: hostMode ? process.env.LOOP_RUNTIME_WORKDIR : env.HOME,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  },
);
child.stderr.resume();
const stop = () => {
  child.kill("SIGTERM");
  process.exit(1);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.once("error", () => process.exit(1));
child.once("close", () => process.exit(1));
const session = new CodexSession(child, {
  hostMode,
  home: env.HOME,
  cwd: process.env.LOOP_RUNTIME_WORKDIR || process.cwd(),
});
session.ready.catch(stop);
const operations = new Map();
const send = (id, event) =>
  process.stdout.write(JSON.stringify({ id, event }) + "\n");
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const message = JSON.parse(line);
  if (message.cancel) {
    operations.get(message.id)?.controller.abort(new Error("Cancelled"));
    continue;
  }
  if (message.steer) {
    const operation = operations.get(message.id);
    void Promise.resolve()
      .then(() => {
        if (!operation?.steer || operation.controller.signal.aborted)
          throw new Error("Turn ended");
        return operation.steer(message.steer.text);
      })
      .then(
        () =>
          send(message.id, {
            steeringResult: { id: message.steer.id, accepted: true },
          }),
        () =>
          send(message.id, {
            steeringResult: { id: message.steer.id, accepted: false },
          }),
      );
    continue;
  }
  if (typeof message.id !== "string" || operations.has(message.id))
    throw new Error("Invalid operation");
  const request = message.request;
  const operation = { controller: new AbortController(), steer: undefined };
  operations.set(message.id, operation);
  const clean = (value) =>
    redactValues(value, request.githubToken ? [request.githubToken] : []);
  void session
    .run(
      request,
      (event) => send(message.id, clean(event)),
      operation.controller.signal,
      (steer) => {
        operation.steer = steer;
      },
    )
    .catch((error) => {
      send(message.id, {
        code:
          error instanceof HarnessError ? "harness_command" : "runtime_failure",
        diagnostic: runtimeFailureFacts(error.details),
        error: diagnosticText(
          clean(
            error instanceof RuntimeFailure || error instanceof HarnessError
              ? error.message
              : "Codex operation stopped.",
          ),
        ),
      });
    })
    .finally(() => {
      operations.delete(message.id);
      send(message.id, { finished: true });
    });
}
stop();
