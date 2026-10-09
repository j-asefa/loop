import {
  diagnosticText,
  errorSummary,
  errorFacts,
  runtimeFailureFacts,
} from "../../runtime/diagnostics.mjs";
import { IDLE_TIMEOUT_MESSAGE } from "../../runtime/idle-deadline.mjs";
import { isNativeConnection } from "./native-connections.js";
import {
  inlineAttachments,
  localPathsPrompt,
  uploadedFile,
} from "./uploads.js";
import { UPLOAD_CHUNK_BYTES, safeUploadName } from "../../runtime/uploads.mjs";
import { nativeSessions } from "./native-sessions.js";
import { companionMode } from "./profile.js";
import { createHash, randomBytes } from "node:crypto";
import { HarnessError } from "../../runtime/harness.mjs";
import { Router } from "express";
import { z } from "zod";
import { db, id, now } from "./db.js";
import { owned, Problem } from "./domain.js";
import { adapter, type ChatInput, type Chunk } from "./providers.js";
import { unseal } from "./secrets.js";
import type { Connection } from "../shared/types.js";
import { runtimeEndpoint } from "./runtime-hosts.js";
import { runtimeGithubCredential } from "./runtime-github.js";
import { redactCredentials } from "./mcp/redaction.js";
import {
  codexStatus,
  codexStream,
  codexCapabilities,
} from "./codex-app-server.js";

export const isSubscription = (c: Connection) =>
  JSON.parse(c.metadata).authMode === "subscription" || isNativeConnection(c);
export const runtimeConfigured = () =>
  !!process.env.LOOP_RUNTIME_URL &&
  (process.env.LOOP_RUNTIME_TOKEN?.length || 0) >= 32;
export const runtimeKey = (c: Connection) =>
  createHash("sha256")
    .update(c.owner_id + "\0" + c.id)
    .digest("hex");
export const runtimeWorkspaceKey = (owner: string, agent: string) =>
  createHash("sha256")
    .update("agent\0" + owner + "\0" + agent)
    .digest("hex");
async function request(
  c: Connection,
  action: string,
  extra: object = {},
  signal?: AbortSignal,
) {
  const endpoint = runtimeEndpoint(
    c.owner_id,
    JSON.parse(c.metadata).runtimeHostId,
    c.provider === "codex" ? "codex" : "claude",
  );
  if (endpoint.kind === "codex-app-server") {
    if (action === "capabilities")
      return Response.json(await codexCapabilities(endpoint));
    // Pair/unpair only Loop's connection. The account on this shared server
    // belongs to the host user and must never be signed out by Loop.
    if (["logout", "cancel"].includes(action))
      return Response.json({ ok: true });
    if (["login", "status"].includes(action))
      return Response.json(await codexStatus(endpoint));
    throw new Problem(
      400,
      "Sign in to Codex on the remote machine, then check the connection again.",
    );
  }
  const r = await endpoint.fetch(endpoint.url + "/runtime", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + endpoint.token,
    },
    body: JSON.stringify({
      key: runtimeKey(c),
      provider: c.provider === "codex" ? "codex" : "claude",
      action,
      ...extra,
    }),
    signal: signal ?? AbortSignal.timeout(45000),
    redirect: "error",
  });
  if (!r.ok) {
    // The runtime names why it refused a file (too large, missing, private).
    // Pass that on: a generic outage message makes agents retry in vain.
    const refusal = (await r.json().catch(() => null)) as {
      code?: unknown;
      error?: unknown;
    } | null;
    if (refusal?.code === "file_rejected" && typeof refusal.error === "string")
      throw new Problem(422, refusal.error.slice(0, 1000));
    throw new Problem(
      422,
      action === "capabilities"
        ? "Cannot load commands while the runtime is unavailable or busy. Try refreshing when its current work finishes."
        : `Subscription runtime unavailable or busy (HTTP ${r.status}). Check the runtime service and try again. No API fallback is used.`,
    );
  }
  return r;
}
export async function runtimeAction(
  c: Connection,
  action: string,
  extra: object = {},
  signal?: AbortSignal,
): Promise<any> {
  // Archived workspace files remain readable without launching a provider.
  if (["read-file", "write-upload", "cleanup"].includes(action))
    return (await request(c, action, extra, signal)).json();
  throw new Problem(410, "Direct subscription runtimes are retired. Connect the harness through HAPI.");
}
// Workspace copies already made by this process. Uploads are immutable, but
// a runtime restart or recreated workspace can remove the copy, so each use
// confirms it is still there before reusing it.
type StagedUpload = {
  name: string;
  path: string;
  file: string;
  size: number;
  sha256: string;
};
const stagedUploads = new Map<string, StagedUpload>();
async function stageUpload(
  c: Connection,
  input: ChatInput,
  fileId: string,
): Promise<{ name: string; path: string }> {
  // Check the cache before loading the file's bytes from the database.
  const cacheKey = [runtimeKey(c), input.workspaceKey ?? "", fileId].join(":");
  const cached = stagedUploads.get(cacheKey);
  if (cached) {
    owned("artifacts", fileId, c.owner_id);
    const present = await runtimeAction(
      c,
      "write-upload",
      {
        workspaceKey: input.workspaceKey,
        fileId,
        transferId: randomBytes(16).toString("hex"),
        name: cached.file,
        size: cached.size,
        sha256: cached.sha256,
        check: true,
      },
      AbortSignal.any([input.signal, AbortSignal.timeout(60000)]),
    ).catch(() => null);
    if (present?.complete === true && present.path === cached.path)
      return { name: cached.name, path: cached.path };
    stagedUploads.delete(cacheKey);
  }
  const { object } = uploadedFile(c.owner_id, fileId);
  const name = safeUploadName(object.name);
  const sha256 = createHash("sha256").update(object.bytes).digest("hex");
  const transferId = randomBytes(16).toString("hex");
  let offset = 0;
  for (;;) {
    const data = object.bytes
      .subarray(offset, offset + UPLOAD_CHUNK_BYTES)
      .toString("base64");
    const result = await runtimeAction(
      c,
      "write-upload",
      {
        workspaceKey: input.workspaceKey,
        fileId,
        transferId,
        name,
        size: object.bytes.length,
        sha256,
        offset,
        data,
      },
      AbortSignal.any([input.signal, AbortSignal.timeout(60000)]),
    );
    if (typeof result?.path !== "string" || result.size !== object.bytes.length)
      throw new Error("Runtime did not confirm the upload");
    if (result.complete === true) {
      if (stagedUploads.size >= 1000)
        stagedUploads.delete(stagedUploads.keys().next().value!);
      stagedUploads.set(cacheKey, {
        name: object.name,
        path: result.path,
        file: name,
        size: object.bytes.length,
        sha256,
      });
      return { name: object.name, path: result.path };
    }
    if (!Number.isSafeInteger(result.nextOffset) || result.nextOffset <= offset)
      throw new Error("Runtime did not confirm the upload");
    offset = result.nextOffset;
  }
}
// Copy the current turn's uploads into the runtime's file system so native
// tools (including image and PDF viewers) open them directly, as companion
// sessions do. Earlier turns keep their file references.
async function stageAttachments(
  c: Connection,
  input: ChatInput,
): Promise<ChatInput> {
  const current = input.messages.findLastIndex((m) => m.role === "user");
  const files = input.messages[current]?.attachments ?? [];
  if (!files.length) return input;
  const local: { name: string; path: string }[] = [];
  const failed: string[] = [];
  for (const file of files) {
    try {
      local.push(await stageUpload(c, input, file.id));
    } catch (error) {
      if (input.signal.aborted) throw error;
      failed.push(file.id);
    }
  }
  const messages = [...input.messages];
  messages[current] = {
    ...messages[current],
    content:
      messages[current].content +
      localPathsPrompt(local) +
      (failed.length
        ? "\nThese files could not be copied to this machine: " +
          JSON.stringify(failed) +
          ". Use loop_read_file to retrieve their original contents."
        : ""),
  };
  return { ...input, messages };
}
export async function* subscriptionStream(
  c: Connection,
  input: ChatInput,
): AsyncGenerator<Chunk> {
  const endpoint = runtimeEndpoint(
    c.owner_id,
    JSON.parse(c.metadata).runtimeHostId,
    c.provider === "codex" ? "codex" : "claude",
  );
  if (endpoint.kind === "codex-app-server") {
    yield* codexStream(endpoint, input);
    return;
  }
  // Native hosts retain their own credentials. Managed containers receive only
  // this owner's allowed GitHub token, per invocation, outside model context.
  const github =
    endpoint.kind === "broker"
      ? runtimeGithubCredential(c.owner_id)
      : undefined;
  input = await stageAttachments(c, input);
  const controlId = id();
  const r = await request(
    c,
    "turn",
    {
      input: { ...input, signal: undefined, steering: undefined, controlId },
      ...(github ? { githubToken: github.token } : {}),
    },
    input.signal,
  );
  if (!r.body) throw new Problem(422, "Runtime returned no response");
  const reader = r.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    done = false;
  let stopSteering: (() => Promise<void>) | undefined;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      if (buffer.length > 2_000_000)
        throw new Problem(422, "Runtime event exceeded its limit");
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const event = redactCredentials(
          JSON.parse(line),
          github ? [github] : [],
        );
        if (event.steeringReady && !stopSteering)
          stopSteering = input.steering?.listen(async (message, inputId) => {
            const response = await request(c, "steer", {
              controlId,
              id: inputId,
              text: message.content,
            });
            if ((await response.json()).accepted !== true)
              throw new Error("Runtime did not confirm delivery");
          });
        if (event.error && event.code === "idle_timeout")
          throw new Problem(408, IDLE_TIMEOUT_MESSAGE);
        if (event.error && event.code === "runtime_failure")
          throw new Problem(
            422,
            `${c.provider === "codex" ? "Codex" : "Claude"} runtime: ${diagnosticText(event.error, [endpoint.token])}`,
            runtimeFailureFacts(event.diagnostic),
          );
        if (event.error)
          throw new Problem(
            422,
            event.code === "harness_command"
              ? String(event.error).slice(0, 1000)
              : "Subscription run stopped. Check sign-in, model access and your allowance. API billing was not used.",
          );
        if (event.chunk) yield event.chunk as Chunk;
        if (event.done) done = true;
      }
    }
    if (!done)
      throw new Problem(
        422,
        "Subscription runtime disconnected before completion. Review partial work before retrying.",
      );
  } catch (error) {
    if (error instanceof Problem || input.signal.aborted) throw error;
    throw new Problem(
      502,
      `${c.provider === "codex" ? "Codex" : "Claude"} runtime connection failed while reading its response (${errorSummary(error, [], false)}). Check Traces for any saved progress.`,
      errorFacts(error),
    );
  } finally {
    await stopSteering?.();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function* streamConnection(c: Connection, input: ChatInput) {
  if (isNativeConnection(c) || isSubscription(c))
    throw new Problem(
      409,
      "Harness execution requires HAPI.",
    );
  // Resolve attachment bytes only at the provider boundary. Checkpoints store
  // references, so large documents are not copied into every history snapshot.
  if (!isSubscription(c))
    input = {
      ...input,
      messages: inlineAttachments(c.owner_id, input.messages),
    };
  try {
    yield* adapter(c.provider).stream(unseal(c.secret, c.owner_id), input);
  } catch (error) {
    // Only failures from the provider stream can invalidate its credentials.
    // MCP ownership and approvals are checked outside this boundary.
    if ([401, 403].includes((error as any)?.status))
      db.prepare(
        "UPDATE connections SET status='needs_reconnect' WHERE id=? AND owner_id=? AND status='connected'",
      ).run(c.id, c.owner_id);
    if (error instanceof HarnessError) throw new Problem(422, error.message);
    if (error instanceof Problem || input.signal.aborted) throw error;
    const message = isSubscription(c)
      ? `The ${c.provider === "codex" ? "Codex" : "Claude"} runtime connection failed (${errorSummary(error, [], false)}). Check Traces for any saved progress.`
      : `${c.provider === "anthropic" ? "Claude" : "OpenAI"} provider: ${errorSummary(error, [unseal(c.secret, c.owner_id)])}`;
    throw new Problem(502, message, errorFacts(error));
  }
}
export const subscriptions = Router();
subscriptions.use("/subscriptions", (_req, _res, next) =>
  next(new Problem(410, "Direct subscription runtimes are retired. Connect the harness through HAPI.")));
