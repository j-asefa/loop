import { it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const dir = mkdtempSync(join(tmpdir(), "loop-share-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { createAgent, renameAgent } = await import("../src/server/domain");
const { seal } = await import("../src/server/secrets");
const { routeHandle, sourceSchema } = await import("../src/server/sharing");
const { submit } = await import("../src/server/agent-runtime");
const { claim } = await import("../src/server/queue");
const c = id();
db.prepare(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,'alice','openai','Fixture',?,'connected',?,?)",
).run(c, seal("fixture", "alice"), JSON.stringify([{ id: "fixture" }]), now());
const a = createAgent("alice", {
  name: "share-agent",
  connectionId: c,
  model: "fixture",
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
it("resolves only accessible handles and preserves old aliases without silent fallback", () => {
  expect(routeHandle("alice", "An untagged question")).toBeNull();
  expect(routeHandle("alice", "@SHARE-AGENT review")).toMatchObject({
    id: a.id,
  });
  expect(() => routeHandle("bob", "@share-agent review")).toThrow(
    /unavailable/,
  );
  expect(() => routeHandle("alice", "@unknown review")).toThrow(/unknown/);
  renameAgent("alice", a.id, "share-agent-renamed");
  expect(routeHandle("alice", "@share-agent review")).toMatchObject({
    id: a.id,
    name: "share-agent-renamed",
  });
});
it("preserves shared context, idempotency and queues behind active work", () => {
  const source = sourceSchema.parse({
      url: "https://github.com/example/repo",
      title: "Example source",
      excerpt: "User-provided fixture",
    }),
    first = submit("alice", {
      agentId: a.id,
      input: "Existing task",
      idempotencyKey: "share-existing",
    });
  expect(claim("fixture")?.id).toBe(first.id);
  const data = {
      agentId: a.id,
      input: "Review shared source",
      source,
      idempotencyKey: "share-new-request",
    },
    second = submit("alice", data);
  expect(submit("alice", data).id).toBe(second.id);
  expect(JSON.parse(second.payload).source).toEqual(source);
  expect(claim("fixture")).toBeUndefined();
  expect(() => sourceSchema.parse({ url: "javascript:alert(1)" })).toThrow();
});
