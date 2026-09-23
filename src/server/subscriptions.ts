import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { db, id, now } from "./db.js";
import { owned, Problem } from "./domain.js";
import { adapter, type ChatInput, type Chunk } from "./providers.js";
import { unseal } from "./secrets.js";
import type { Connection } from "../shared/types.js";

export const isSubscription = (c: Connection) =>
  JSON.parse(c.metadata).authMode === "subscription";
export const runtimeConfigured = () =>
  !!process.env.LOOP_RUNTIME_URL &&
  (process.env.LOOP_RUNTIME_TOKEN?.length || 0) >= 32;
export const runtimeKey = (c: Connection) =>
  createHash("sha256")
    .update(c.owner_id + "\0" + c.id)
    .digest("hex");
async function request(
  c: Connection,
  action: string,
  extra: object = {},
  signal?: AbortSignal,
) {
  if (!runtimeConfigured())
    throw new Problem(
      503,
      "Start the subscription runtime service with Docker Compose, then try again.",
    );
  const r = await fetch(
    process.env.LOOP_RUNTIME_URL!.replace(/\/$/, "") + "/runtime",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + process.env.LOOP_RUNTIME_TOKEN,
      },
      body: JSON.stringify({
        key: runtimeKey(c),
        provider: c.provider === "codex" ? "codex" : "claude",
        action,
        ...extra,
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(1800000)])
        : AbortSignal.timeout(45000),
    },
  );
  if (!r.ok)
    throw new Problem(
      422,
      "Subscription runtime unavailable or busy. Check the runtime service and try again. No API fallback is used.",
    );
  return r;
}
export async function runtimeAction(
  c: Connection,
  action: string,
  extra: object = {},
) {
  try {
    return await (await request(c, action, extra)).json();
  } catch (e) {
    if (e instanceof Problem) throw e;
    throw new Problem(
      503,
      "Cannot reach the subscription runtime service. Check Docker Compose.",
    );
  }
}
export async function* subscriptionStream(
  c: Connection,
  input: ChatInput,
): AsyncGenerator<Chunk> {
  const r = await request(
    c,
    "turn",
    { input: { ...input, signal: undefined } },
    input.signal,
  );
  if (!r.body) throw new Problem(422, "Runtime returned no response");
  const reader = r.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    done = false,
    total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      if (total > 2_000_000)
        throw new Problem(422, "Runtime response exceeded its limit");
      buffer += decoder.decode(next.value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.error)
          throw new Problem(
            422,
            "Subscription run stopped. Check sign-in, model access and your allowance. API billing was not used.",
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
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function* streamConnection(c: Connection, input: ChatInput) {
  try {
    yield* isSubscription(c)
      ? subscriptionStream(c, input)
      : adapter(c.provider).stream(unseal(c.secret, c.owner_id), input);
  } catch (error) {
    // Only failures from the provider stream can invalidate its credentials.
    // MCP grants and approvals are checked outside this boundary.
    if ([401, 403].includes((error as any)?.status))
      db.prepare(
        "UPDATE connections SET status='needs_reconnect' WHERE id=? AND owner_id=? AND status='connected'",
      ).run(c.id, c.owner_id);
    throw error;
  }
}
export const subscriptions = Router();
subscriptions.post("/subscriptions", (req, res) => {
  if (!runtimeConfigured())
    throw new Problem(
      503,
      "Subscription runtimes are not configured. Start the supplied Docker Compose services.",
    );
  const d = z
    .object({
      provider: z.enum(["codex", "claude"]),
      label: z.string().trim().min(1).max(80),
    })
    .parse(req.body);
  const owner = res.locals.owner;
  const record = db
    .transaction(() => {
      const count = db
        .prepare(
          "SELECT count(*) n FROM connections WHERE owner_id=? AND json_extract(metadata,'$.authMode')='subscription'",
        )
        .get(owner) as { n: number };
      if (count.n >= 8)
        throw new Problem(
          409,
          "Use an existing subscription connection; this workspace already has eight.",
        );
      const key = id();
      db.prepare(
        "INSERT INTO connections(id,owner_id,provider,label,secret,status,metadata,created_at) VALUES(?,?,?,?,'','needs_sign_in',?,?)",
      ).run(
        key,
        owner,
        d.provider === "codex" ? "codex" : "anthropic",
        d.label,
        JSON.stringify({
          authMode: "subscription",
          runtime: d.provider,
          billing: "Subscription allowance",
          scope:
            "Official runtime sign-in; no API fallback. Past chats are imported separately.",
        }),
        now(),
      );
      return owned<Connection>("connections", key, owner);
    })
    .immediate();
  res.status(201).json({ id: record.id });
});
subscriptions.post("/subscriptions/:id/:action", async (req, res) => {
  const c = owned<Connection>(
    "connections",
    String(req.params.id),
    res.locals.owner,
  );
  if (!isSubscription(c))
    throw new Problem(400, "This connection uses an API key");
  const action = z
    .enum(["login", "status", "code", "cancel"])
    .parse(req.params.action);
  if (action === "status" && c.status === "disconnected") {
    res.json({ authenticated: false });
    return;
  }
  if (action === "code") {
    const code = z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .regex(/^[^\r\n]+$/)
      .parse(req.body.code);
    res.json(await runtimeAction(c, action, { code }));
    return;
  }
  if (action === "login")
    db.prepare("UPDATE connections SET status='signing_in' WHERE id=?").run(
      c.id,
    );
  const result = await runtimeAction(c, action);
  if (
    owned<Connection>("connections", c.id, c.owner_id).status === "disconnected"
  ) {
    res.json({ authenticated: false });
    return;
  }
  // Only expose the native runtime's auth result. A login URL is never proof of connection.
  if (result.authenticated === true && result.authMode === "subscription") {
    const models = z
      .array(
        z.object({
          id: z.string().max(200),
          name: z.string().max(200),
          capabilities: z.string().max(500),
        }),
      )
      .max(300)
      .parse(result.models);
    db.prepare(
      "UPDATE connections SET models=?,status='connected',metadata=? WHERE id=? AND status<>'disconnected'",
    ).run(
      JSON.stringify(models),
      JSON.stringify({
        ...JSON.parse(c.metadata),
        plan: result.plan,
        limits: result.limits,
        checkedAt: now(),
      }),
      c.id,
    );
  } else if (
    result.authenticated === false ||
    ["failed", "cancelled"].includes(result.state) ||
    action === "cancel"
  ) {
    db.prepare("UPDATE connections SET status='needs_sign_in' WHERE id=?").run(
      c.id,
    );
  }
  res.json(result);
});
