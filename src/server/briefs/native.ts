import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { conflict } from "../../adapters/types.js";
import type { Connection } from "../../shared/types.js";
import { canGenerateBrief } from "../../shared/brief-connections.js";
import { Problem } from "../domain.js";
import { nativeSessions, OWNER } from "../native-sessions.js";
import { companionMode } from "../profile.js";
import type { ChatInput, Chunk } from "../providers.js";

/** An isolated subscription projection; never opens or resumes an agent session. */
export async function* nativeBriefStream(
  connection: Connection,
  input: ChatInput,
): AsyncGenerator<Chunk> {
  const harness = JSON.parse(connection.metadata).loopHarness;
  if (
    !companionMode ||
    connection.owner_id !== OWNER ||
    !canGenerateBrief(connection) ||
    !["codex", "claude"].includes(harness) ||
    input.nativeTools !== false ||
    input.toolChoice !== "submit_brief"
  )
    throw new Problem(
      409,
      "This connection cannot run a native project brief.",
    );
  const options = nativeSessions.registration(harness);
  if (options.billing !== "subscription")
    throw new Problem(
      409,
      "Verify this harness's subscription before enabling briefs.",
    );
  conflict(
    "subscription",
    harness === "codex"
      ? ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"]
      : [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "ANTHROPIC_BASE_URL",
          "CLAUDE_CODE_USE_BEDROCK",
          "CLAUDE_CODE_USE_VERTEX",
          "CLAUDE_CODE_USE_FOUNDRY",
        ],
  );
  input.signal.throwIfAborted();
  const cwd = mkdtempSync(join(tmpdir(), "loop-brief-native-"));
  const processGroup = process.platform !== "win32";
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../../../runtime/entry.mjs", import.meta.url))],
    {
      cwd,
      env: {
        ...process.env,
        LOOP_RUNTIME_MODE: "host",
        LOOP_RUNTIME_WORKDIR: cwd,
        LOOP_RUNTIME_EXECUTABLE: options.executable,
        LOOP_RUNTIME_BRIEF_PROJECT: options.project,
      },
      detached: processGroup,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stop = () => {
    if (processGroup && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already stopped. */
      }
    } else child.kill("SIGKILL");
  };
  const chunks: Chunk[] = [];
  let buffer = "",
    bytes = 0,
    done = false,
    failure: Error | undefined;
  const runtimeFailed = () =>
    new Problem(
      422,
      "The brief subscription runtime stopped. Check native sign-in, the selected model and your allowance. No API fallback was used.",
    );
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdin.on("error", (error) => {
      failure = error;
      stop();
    });
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      try {
        buffer += text;
        if (Buffer.byteLength(buffer) > 2_000_000) throw runtimeFailed();
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.error) throw runtimeFailed();
          if (event.done) done = true;
          if (event.chunk?.toolCall || event.chunk?.text) {
            bytes += Buffer.byteLength(line);
            if (bytes > 200_000 || chunks.length >= 100) throw runtimeFailed();
            chunks.push(event.chunk);
          }
        }
      } catch (error) {
        failure = error instanceof Problem ? error : runtimeFailed();
        stop();
      }
    });
    child.once("close", (code) => {
      if (input.signal.aborted) reject(input.signal.reason);
      else if (failure || code !== 0 || !done || buffer.trim())
        reject(failure || runtimeFailed());
      else resolve();
    });
  });
  input.signal.addEventListener("abort", stop, { once: true });
  try {
    if (input.signal.aborted) stop();
    else
      child.stdin.end(
        JSON.stringify({
          provider: harness,
          action: "project-brief",
          input: { ...input, signal: undefined, steering: undefined },
        }) + "\n",
      );
    await completion;
    yield* chunks;
  } finally {
    input.signal.removeEventListener("abort", stop);
    stop();
    rmSync(cwd, { recursive: true, force: true });
  }
}
