import { ConversationId } from "../src/shared/contract-ids.js";
import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { workspaceApi, type RouteContract } from "../src/shared/workspace-api";
import { PublicRun } from "../src/shared/workspace-contract-schemas.js";
import { callRoute, readRoute } from "../src/client/api";

const directory = mkdtempSync(join(tmpdir(), "loop-mobile-contracts-"));
process.env.LOOP_DATA_DIR = directory;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id } = await import("../src/server/db");
const { app } = await import("../src/server/index");
const { withTestAdapter } = await import("../src/server/providers");
const { nativeSessions } = await import("../src/server/native-sessions");
const { closeExecution } = await import("../src/server/execution-client");
const { submit } = await import("../src/server/agent-runtime");
const { claim, transition } = await import("../src/server/queue");
const { recordConversationUpdate } =
  await import("../src/server/conversation-updates");
const { saveArtifact } = await import("../src/server/artifacts");
const { uploadFile } = await import("../src/server/uploads");
const mobile = await import("../src/server/mobile-return");
const { runResponse, parseRun } = await import("../src/server/row-schemas");
const owner = "local-workspace";
const restore = withTestAdapter("openai", {
  async models() {
    return [
      { id: "fixture", name: "Fixture", capabilities: "Isolated fixture" },
    ];
  },
  async *stream() {
    yield { text: "Fixture response" };
  },
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
async function request(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const r = await fetch(origin + "/api" + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}
async function invalid(path: string, method = "GET") {
  // No-body reads reject a JSON body; historically body-agnostic mutations
  // still reject malformed JSON at the production parser, before the action.
  const payload = method === "GET" ? "{}" : "{";
  return new Promise<{ status: number; data: unknown }>((resolve, reject) => {
    const req = httpRequest(
      origin + "/api" + path,
      {
        method,
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            data: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}
function valid(
  contract: RouteContract,
  result: Awaited<ReturnType<typeof request>>,
  status = contract.status ?? 200,
) {
  expect(result.status, JSON.stringify(result.data)).toBe(status);
  expect(contract.response.parse(result.data)).toEqual(result.data);
}
const bad = { status: 400, data: { error: expect.any(String) } };
const connection = (
  await request("/connections", {
    provider: "openai",
    label: "Fixture",
    secret: "fixture-private-key",
  })
).data;
const agent = (
  await request("/agents", {
    name: "mobile-contract",
    connectionId: connection.id,
    model: "fixture",
  })
).data;
const destination = (
  await request("/agents", {
    name: "mobile-destination",
    connectionId: connection.id,
    model: "fixture",
  })
).data;
const folder = (
  await request("/folders", { name: "Contract project", kind: "project" })
).data;
const queued = submit(owner, {
  agentId: agent.id,
  input: "Contract prompt",
  idempotencyKey: id(),
  folderId: folder.id,
});
const run = claim("contract-fixture")!;
expect(run.id).toBe(queued.id);
const message = db
  .prepare("SELECT id,content FROM messages WHERE run_id=? AND role='user'")
  .get(run.id) as { id: string; content: string };
const progress = recordConversationUpdate(run, "contract-progress", {
  content: "Still working",
  metadata: { progress: true },
})!;
expect(transition(run, "completed")).toBe(true);
const conversation = run.conversation_id!;
const file = uploadFile(owner, {
  originalname: "contract.txt",
  mimetype: "text/plain",
  buffer: Buffer.from("Contract attachment"),
});
const foreign = saveArtifact("other-owner", {
  title: "Private",
  content: "Private",
  role: "answer",
});
const laterInput = () => ({
  kind: "conversation",
  targetId: conversation,
  condition: "time",
  dueAt: Date.now() + 60_000,
});
const laterRow = (target: string) =>
  db.prepare("SELECT * FROM later_items WHERE id=?").get(target);
const scheduledRow = (target: string) =>
  db.prepare("SELECT * FROM scheduled_sends WHERE id=?").get(target);
const schedule = () => ({
  agentId: agent.id,
  input: "Scheduled contract",
  sendAt: Date.now() + 60_000,
  idempotencyKey: id(),
  attachmentIds: [file.id],
});
const freshRun = () =>
  submit(owner, {
    agentId: agent.id,
    input: "Queued contract",
    idempotencyKey: id(),
    attachmentIds: [file.id],
  });

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeExecution();
  await nativeSessions.close();
  restore();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("conversationPosition saves and clears an owned message position", async () => {
  const path = `/conversations/${conversation}/position`;
  expect(await request(path, {}, "PUT")).toMatchObject(bad);
  const result = await request(path, { positionMessageId: message.id }, "PUT");
  valid(workspaceApi.conversationPosition, result);
  expect(result.data).toMatchObject(
    db
      .prepare(
        "SELECT position_message_id FROM conversation_positions WHERE conversation_id=?",
      )
      .get(conversation)!,
  );
  expect(
    (await request(path, { positionMessageId: null }, "PUT")).data
      .position_message_id,
  ).toBeNull();
});
it("feedUpdate hides only the named Done card and preserves its response", async () => {
  const path = `/feed/${conversation}`;
  expect(
    await request(path, { hidden: true, cardKey: "invalid" }, "PATCH"),
  ).toMatchObject(bad);
  const result = await request(
    path,
    { hidden: true, cardKey: `run:${run.id}` },
    "PATCH",
  );
  valid(workspaceApi.feedUpdate, result);
  expect(
    mobile
      .feed(owner, { filter: "done" })
      .items.some((item) => item.done_card_key === `run:${run.id}`),
  ).toBe(false);
  const restored = await request(
    path,
    { hidden: false, cardKey: `run:${run.id}` },
    "PATCH",
  );
  valid(workspaceApi.feedUpdate, restored);
});
it("feedAway preserves summaries from production runs and rejects invalid timestamps", async () => {
  const result = await request("/feed/away?since=0");
  valid(workspaceApi.feedAway, result);
  expect(result.data).toEqual(mobile.awaySummary(owner, 0));
  expect(
    result.data.completed.some(
      (item: { run_id: string }) => item.run_id === run.id,
    ),
  ).toBe(true);
  expect(await request("/feed/away?since=-1")).toMatchObject(bad);
});
it("messageSave keeps the bookmark and rejects progress messages or malformed input", async () => {
  expect(await invalid(`/messages/${message.id}/saved`, "POST")).toMatchObject(
    bad,
  );
  expect(await request(`/messages/${progress.id}/saved`, {})).toMatchObject(
    bad,
  );
  const result = await request(`/messages/${message.id}/saved`, {});
  valid(workspaceApi.messageSave, result);
  expect(result.data.saved).toBe(true);
  expect(
    db
      .prepare(
        "SELECT 1 FROM message_bookmarks WHERE message_id=? AND owner_id=?",
      )
      .get(message.id, owner),
  ).toBeTruthy();
});
it("messageUnsave removes the owned bookmark", async () => {
  expect(
    await invalid(`/messages/${message.id}/saved`, "DELETE"),
  ).toMatchObject(bad);
  const result = await request(
    `/messages/${message.id}/saved`,
    undefined,
    "DELETE",
  );
  valid(workspaceApi.messageUnsave, result);
  expect(result.data.saved).toBe(false);
  expect(
    db
      .prepare("SELECT 1 FROM message_bookmarks WHERE message_id=?")
      .get(message.id),
  ).toBeUndefined();
});
it("savedList preserves both production bookmark and pinned-artifact projections", async () => {
  mobile.setSaved(owner, message.id, true);
  const artifact = saveArtifact(owner, {
    title: "Saved contract",
    content: "Decision",
    conversation,
    agent: agent.id,
    run: run.id,
    role: "answer",
  });
  db.prepare("UPDATE artifacts SET pinned=1 WHERE id=?").run(artifact);
  const result = await request("/saved");
  valid(workspaceApi.savedList, result);
  expect(result.data).toEqual(mobile.listSaved(owner));
  expect(
    result.data.items.map((item: { kind: string }) => item.kind).sort(),
  ).toEqual(["message", "result"]);
  expect(
    workspaceApi.savedList.response.safeParse({
      ...result.data,
      items: result.data.items.map((item: object) => ({ ...item, label: 123 })),
    }).success,
  ).toBe(false);
  expect(await request("/saved?before=invalid")).toMatchObject(bad);
});
it("savedLabel trims an owned bookmark label and rejects invalid keys", async () => {
  expect(
    await request("/saved/label", { key: "wrong", label: "Text" }, "PUT"),
  ).toMatchObject(bad);
  const result = await request(
    "/saved/label",
    { key: `m:${message.id}`, label: "  Review  " },
    "PUT",
  );
  valid(workspaceApi.savedLabel, result);
  expect(
    mobile.listSaved(owner).items.find((item) => item.key === result.data.key)
      ?.label,
  ).toBe(result.data.label);
  expect(result.data.label).toBe("Review");
});
it("conversationOutline retains ordinary and search branches without inventing matches", async () => {
  for (const q of [undefined, "contract"]) {
    const result = await request(
      `/conversations/${conversation}/outline` + (q ? `?q=${q}` : ""),
    );
    valid(workspaceApi.conversationOutline, result);
    expect(result.data).toEqual(
      mobile.conversationOutline(owner, conversation, q),
    );
    if (!q) expect(result.data).not.toHaveProperty("matches");
    else
      expect(
        workspaceApi.conversationOutline.response.safeParse({
          ...result.data,
          matches: "broken",
        }).success,
      ).toBe(false);
  }
  expect(
    await request(
      `/conversations/${conversation}/outline?q=${"x".repeat(201)}`,
    ),
  ).toMatchObject(bad);
});
it("laterCreate requires its existing target and trigger, and reports replacement identity", async () => {
  expect(await request("/later", { condition: "time" })).toMatchObject(bad);
  const result = await request("/later", laterInput());
  valid(workspaceApi.laterCreate, result);
  expect(result.data).toEqual({ ...laterRow(result.data.id)!, replaced: null });
  const next = await request("/later", laterInput());
  valid(workspaceApi.laterCreate, next);
  expect(next.data.replaced).toBe(result.data.id);
  expect(
    (
      await request("/later", {
        ...laterInput(),
        kind: "artifact",
        targetId: foreign,
      })
    ).status,
  ).toBe(404);
});
it("laterList preserves production reminder views", async () => {
  const result = await request("/later");
  valid(workspaceApi.laterList, result);
  expect(result.data).toEqual(mobile.listLater(owner));
  expect(result.data.upcoming.length).toBeGreaterThan(0);
  expect(await invalid("/later")).toMatchObject(bad);
});
it("laterFinish marks a reminder done without deleting its identity", async () => {
  const row = mobile.createLater(owner, laterInput());
  expect(await invalid(`/later/${row.id}`, "DELETE")).toMatchObject(bad);
  const result = await request(`/later/${row.id}`, undefined, "DELETE");
  valid(workspaceApi.laterFinish, result);
  expect(laterRow(row.id)).toMatchObject({
    id: row.id,
    done_at: expect.any(Number),
  });
});
it("laterSnooze keeps the reminder identity and increments its counter", async () => {
  const row = mobile.createLater(owner, laterInput());
  expect(
    await request(`/later/${row.id}/snooze`, { condition: "time" }),
  ).toMatchObject(bad);
  const result = await request(`/later/${row.id}/snooze`, {
    condition: "time",
    dueAt: Date.now() + 120_000,
  });
  valid(workspaceApi.laterSnooze, result);
  expect(result.data).toEqual(laterRow(row.id));
  expect(result.data.snoozes).toBe(1);
});
it("laterReopen restores the same reminder and refuses conflicts", async () => {
  const row = mobile.createLater(owner, laterInput());
  mobile.finishLater(owner, row.id);
  expect(await invalid(`/later/${row.id}/reopen`, "POST")).toMatchObject(bad);
  const result = await request(`/later/${row.id}/reopen`, {});
  valid(workspaceApi.laterReopen, result);
  expect(result.data).toEqual(laterRow(row.id));
  expect(result.data.done_at).toBeNull();
  mobile.createLater(owner, laterInput());
  expect((await request(`/later/${row.id}/reopen`, {})).status).toBe(409);
});
it("projectOpened surfaces only its project-triggered reminder", async () => {
  const row = mobile.createLater(owner, {
    kind: "conversation",
    targetId: conversation,
    condition: "project_open",
    projectId: folder.id,
  });
  expect(await invalid(`/projects/${folder.id}/opened`, "POST")).toMatchObject(
    bad,
  );
  const result = await request(`/projects/${folder.id}/opened`, {});
  valid(workspaceApi.projectOpened, result);
  expect(result.data.surfaced).toBe(1);
  expect(laterRow(row.id)).toMatchObject({ surfaced_at: expect.any(Number) });
});
it("projectSummaries preserves real project counts and latest-result joins", async () => {
  const result = await request("/projects/summary");
  valid(workspaceApi.projectSummaries, result);
  expect(result.data).toEqual(mobile.projectSummaries(owner));
  expect(
    result.data.items.some((item: { id: string }) => item.id === folder.id),
  ).toBe(true);
  expect(await invalid("/projects/summary")).toMatchObject(bad);
});
it("scheduledSendCreate requires its key and preserves 201/200 replay before clock validation", async () => {
  const body = schedule();
  const { idempotencyKey: _, ...missing } = body;
  expect(await request("/scheduled-sends", missing)).toMatchObject(bad);
  const result = await request("/scheduled-sends", body);
  valid(workspaceApi.scheduledSendCreate, result);
  expect(result.data).toEqual(scheduledRow(result.data.id));
  const clock = vi.spyOn(Date, "now").mockReturnValue(body.sendAt + 1);
  try {
    const replay = await request("/scheduled-sends", body);
    valid(workspaceApi.scheduledSendCreate, replay, 200);
    expect(replay.data).toEqual(result.data);
  } finally {
    clock.mockRestore();
  }
  expect(
    (await request("/scheduled-sends", { ...body, input: "Changed intent" }))
      .status,
  ).toBe(409);
});
it("scheduledSendList projects stored upload descriptors and preserves the failed cursor", async () => {
  const result = await request("/scheduled-sends");
  valid(workspaceApi.scheduledSendList, result);
  expect(result.data).toEqual(mobile.listScheduledSends(owner));
  expect(result.data.items[0].attachments[0]).toEqual(file);
  expect(await request("/scheduled-sends?failedBefore=invalid")).toMatchObject(
    bad,
  );
});
it("scheduledSendCancel cancels an owned pending send", async () => {
  const row = mobile.createScheduledSend(owner, schedule()).row;
  expect(await invalid(`/scheduled-sends/${row.id}`, "DELETE")).toMatchObject(
    bad,
  );
  const result = await request(
    `/scheduled-sends/${row.id}`,
    undefined,
    "DELETE",
  );
  valid(workspaceApi.scheduledSendCancel, result);
  expect(scheduledRow(row.id)).toMatchObject({ state: "cancelled" });
});
it("scheduledSendUpdate preserves partial edits and rejects blank input", async () => {
  const row = mobile.createScheduledSend(owner, schedule()).row;
  expect(
    await request(`/scheduled-sends/${row.id}`, { input: " " }, "PATCH"),
  ).toMatchObject(bad);
  const result = await request(
    `/scheduled-sends/${row.id}`,
    { input: "  Edited schedule  " },
    "PATCH",
  );
  valid(workspaceApi.scheduledSendUpdate, result);
  expect(result.data).toEqual(scheduledRow(row.id));
  expect(result.data.input).toBe("Edited schedule");
  const empty = await request(`/scheduled-sends/${row.id}`, undefined, "PATCH");
  valid(workspaceApi.scheduledSendUpdate, empty);
  expect(empty.data).toEqual(result.data);
});
it("scheduledSendRetry returns the accepted production run and matching row", async () => {
  const row = mobile.createScheduledSend(owner, schedule()).row;
  db.prepare(
    "UPDATE scheduled_sends SET state='failed',error='Fixture refusal' WHERE id=?",
  ).run(row.id);
  expect(
    await invalid(`/scheduled-sends/${row.id}/retry`, "POST"),
  ).toMatchObject(bad);
  const result = await request(`/scheduled-sends/${row.id}/retry`, {});
  valid(workspaceApi.scheduledSendRetry, result);
  expect(result.data.row).toEqual(scheduledRow(row.id));
  expect(result.data.run).toEqual(
    PublicRun.parse(
      runResponse(
        parseRun(
          db.prepare("SELECT * FROM runs WHERE id=?").get(result.data.run.id),
        ),
      ),
    ),
  );
  expect(result.data.row.run_id).toBe(result.data.run.id);
});
it("runReorder changes queue order and rejects an invalid direction", async () => {
  const first = freshRun(),
    second = freshRun();
  expect(
    await request(`/runs/${second.id}/reorder`, { direction: "left" }),
  ).toMatchObject(bad);
  const result = await request(`/runs/${second.id}/reorder`, {
    direction: "up",
  });
  valid(workspaceApi.runReorder, result);
  const order = db
    .prepare(
      "SELECT id FROM runs WHERE id IN (?,?) ORDER BY queue_rank,created_at,id",
    )
    .all(first.id, second.id);
  expect(order[0]).toMatchObject({ id: second.id });
});
it("runUpdate changes the queued prompt and rejects blank input", async () => {
  const row = freshRun();
  expect(
    await request(`/runs/${row.id}`, { input: " " }, "PATCH"),
  ).toMatchObject(bad);
  const result = await request(
    `/runs/${row.id}`,
    { input: "  Edited queue  " },
    "PATCH",
  );
  valid(workspaceApi.runUpdate, result);
  expect(db.prepare("SELECT input FROM runs WHERE id=?").get(row.id)).toEqual({
    input: "Edited queue",
  });
  expect(
    db
      .prepare("SELECT content FROM messages WHERE run_id=? AND role='user'")
      .get(row.id),
  ).toEqual({ content: "Edited queue" });
});
it("runWithdraw returns the actual draft and files only after cancelling queued work", async () => {
  const row = freshRun();
  expect(
    await request(`/runs/${row.id}/withdraw`, {
      draftAttachmentIds: "invalid",
    }),
  ).toMatchObject(bad);
  const result = await request(`/runs/${row.id}/withdraw`, {});
  valid(workspaceApi.runWithdraw, result);
  expect(result.data).toEqual({
    input: row.input,
    agent_id: row.agent_id,
    conversation_id: row.conversation_id,
    attachment_ids: [file.id],
    attachments: [file],
  });
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(row.id)).toEqual({
    state: "cancelled",
  });
});
it("runMove requires its identity and replays the original destination receipt", async () => {
  const row = freshRun(),
    body = { agentId: destination.id, idempotencyKey: id() };
  expect(
    await request(`/runs/${row.id}/move`, { agentId: destination.id }),
  ).toMatchObject(bad);
  const result = await request(`/runs/${row.id}/move`, body);
  valid(workspaceApi.runMove, result);
  expect(result.data).toEqual(
    PublicRun.parse(
      runResponse(
        parseRun(
          db.prepare("SELECT * FROM runs WHERE id=?").get(result.data.id),
        ),
      ),
    ),
  );
  expect(result.data.agent_id).toBe(destination.id);
  const replay = await request(`/runs/${row.id}/move`, body);
  valid(workspaceApi.runMove, replay);
  expect(replay.data.id).toBe(result.data.id);
});
it("conversationFork copies production messages through the requested message", async () => {
  expect(
    await request(`/conversations/${conversation}/fork`, {}),
  ).toMatchObject(bad);
  const result = await request(`/conversations/${conversation}/fork`, {
    messageId: message.id,
  });
  valid(workspaceApi.conversationFork, result);
  expect(result.data.agentId).toBe(agent.id);
  const copied = db
    .prepare(
      "SELECT content,metadata FROM messages WHERE conversation_id=? ORDER BY created_at,rowid",
    )
    .all(result.data.id) as { content: string; metadata: string }[];
  expect(copied.at(-1)?.content).toBe(
    (
      db.prepare("SELECT content FROM messages WHERE id=?").get(message.id) as {
        content: string;
      }
    ).content,
  );
  expect(JSON.parse(copied.at(-1)!.metadata).sourceMessage).toBe(message.id);
});
it("conversationUsage preserves production receipts and memory identities", async () => {
  db.prepare(
    "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,?,'native.usage',?,?)",
  ).run(
    owner,
    run.id,
    JSON.stringify({ usage: { input_tokens: 1200, output_tokens: 300 } }),
    Date.now(),
  );
  db.prepare("INSERT INTO memory_receipts VALUES(?,'shared','[]',5,?)").run(
    run.id,
    Date.now(),
  );
  const result = await request(`/conversations/${conversation}/usage`);
  valid(workspaceApi.conversationUsage, result);
  expect(result.data).toEqual(mobile.conversationUsage(owner, conversation));
  expect(result.data.memory).toContain(run.id);
  expect(
    workspaceApi.conversationUsage.response.safeParse({
      ...result.data,
      memory: "invalid",
    }).success,
  ).toBe(false);
  expect(await invalid(`/conversations/${conversation}/usage`)).toMatchObject(
    bad,
  );
});
it("snippetList returns production snippet artifacts with their timestamps", async () => {
  const snippet = saveArtifact(owner, {
    title: "Saved prompt: Contract",
    content: "Snippet contract",
    metadata: { snippet: true },
    role: "snippet",
  });
  const result = await request("/snippets");
  valid(workspaceApi.snippetList, result);
  expect(result.data).toEqual(mobile.listSnippets(owner));
  expect(result.data.items[0].id).toBe(snippet);
  expect(await invalid("/snippets")).toMatchObject(bad);
});
it("typed mobile clients consume production receipts, saved envelopes and cancellation", async () => {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("location", { href: origin + "/", origin, search: "" });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    return realFetch(new URL(path, origin), init);
  });
  try {
    const saved = await callRoute(workspaceApi.savedList, {}, "");
    expect(saved.items).not.toHaveLength(0);
    for (const item of saved.items) expect(item).toHaveProperty("label");
    const row = await callRoute(
      workspaceApi.laterCreate,
      { body: { ...laterInput(), kind: "conversation", condition: "time" } },
      "",
    );
    expect(row).toEqual({ ...laterRow(row.id)!, replaced: row.replaced });
    const result = await readRoute(
      workspaceApi.scheduledSendList,
      {},
      "",
      new AbortController().signal,
    );
    expect(result).toEqual(mobile.listScheduledSends(owner));
    const controller = new AbortController();
    controller.abort();
    await expect(
      readRoute(
        workspaceApi.conversationUsage,
        { params: { id: ConversationId.parse(conversation) } },
        "",
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    vi.unstubAllGlobals();
  }
});
