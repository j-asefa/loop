import { afterAll, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { gitProject } from "./git-project.js";
import { workspaceApi, type RouteContract } from "../src/shared/workspace-api";
import { PublicRun } from "../src/shared/workspace-contract-schemas.js";
import { callRoute, fetchStream, readRoute } from "../src/client/api";

vi.mock("../src/server/local-embeddings.js", () => ({
  localModel: "fixture-local",
  localEmbeddings: async (texts: string[]) => texts.map(() => [1, 0]),
}));
const directory = mkdtempSync(join(tmpdir(), "loop-library-contracts-"));
process.env.LOOP_DATA_DIR = directory;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id } = await import("../src/server/db");
const { app } = await import("../src/server/index");
const { withTestAdapter } = await import("../src/server/providers");
const { nativeSessions } = await import("../src/server/native-sessions");
const { closeExecution } = await import("../src/server/execution-client");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { claim, transition } = await import("../src/server/queue");
const { ownedArtifact } = await import("../src/server/domain");
const { artifactResponse } = await import("../src/server/row-schemas");
const { storePublishedFile } = await import("../src/server/published-files");
const { startCheckout, completeCheckout, checkoutDetail } =
  await import("../src/server/run-checkouts");
const { observeCompletedOutput, runVerifications } =
  await import("../src/server/run-verifications");
const { search, searchStatus, indexPending } =
  await import("../src/server/search");
const { stageImport, executeImport } = await import("../src/server/imports");
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
async function multipart(
  path: string,
  bytes: Uint8Array,
  name: string,
  fields: Record<string, string> = {},
) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)]), name);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const r = await fetch(origin + "/api" + path, { method: "POST", body: form });
  return { status: r.status, data: await r.json() };
}
async function invalid(path: string, method = "GET") {
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
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            data: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
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
    name: "library-contract",
    connectionId: connection.id,
    model: "fixture",
  })
).data;
const folder = (
  await request("/folders", { name: "Library project", kind: "project" })
).data;
const artifact = (
  await request("/artifacts", {
    title: "Library contract",
    content: "Library contract content",
    folder: folder.id,
  })
).data;
const submitted = submit(owner, {
  agentId: agent.id,
  input: "Library prompt",
  idempotencyKey: id(),
  folderId: folder.id,
});
const run = claim("library-fixture")!;
expect(run.id).toBe(submitted.id);
const message = db
  .prepare("SELECT id FROM messages WHERE run_id=? AND role='user'")
  .get(run.id) as { id: string };
const published = storePublishedFile(run, id(), {
  name: "library.txt",
  title: "Published library",
  mime: "text/plain",
  bytes: Buffer.from("Published bytes"),
});
const project = join(directory, "repo");
mkdirSync(project);
const git = gitProject(project);
writeFileSync(join(project, ".gitattributes"), "tracked.txt filter=fixture\n");
git("add", ".gitattributes");
git(
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.com",
  "commit",
  "-m",
  "attributes",
);
await startCheckout(run, project, project, "library-generation");
writeFileSync(join(project, "tracked.txt"), "Changed by the fixture\n");
await completeCheckout(run.id);
observeCompletedOutput(run, {
  command: "npm test",
  status: "exited",
  exitCode: 0,
  chunks: [{ stream: "combined", text: "Fixture checks passed\n", index: 0 }],
  streams: "combined",
  truncated: { droppedBytes: 0, droppedChunks: 0, floor: 0 },
  nextIndex: 1,
  pending: [],
});
expect(transition(run, "completed")).toBe(true);
const bytes = Buffer.from("<p>Private original file</p>");
const uploaded = await multipart("/uploads", bytes, "original.html", {
  folderId: folder.id,
});
const archive = readFileSync("test/fixtures/chatgpt-export.zip");
const preview = await multipart("/imports/preview", archive, "export.zip");
const importId = preview.data.id;
const importRow = () =>
  db.prepare("SELECT * FROM imports WHERE id=?").get(importId);
const currentArtifact = () =>
  artifactResponse(ownedArtifact(artifact.id, owner));

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeExecution();
  await nativeSessions.close();
  restore();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("uploadCreate retains multipart fields, stored bytes and its descriptor", async () => {
  valid(workspaceApi.uploadCreate, uploaded);
  expect(
    (
      db
        .prepare("SELECT role FROM artifacts WHERE id=?")
        .get(uploaded.data.id) as { role: string }
    ).role,
  ).toBe("upload");
  const stored = db
    .prepare("SELECT name,bytes FROM objects WHERE id=?")
    .get(uploaded.data.objectId) as { name: string; bytes: Buffer };
  expect(stored.name).toBe(uploaded.data.name);
  expect(stored.bytes).toEqual(bytes);
  expect(uploaded.data.size).toBe(bytes.length);
  expect(
    await multipart("/uploads", bytes, "invalid.html", { folderId: "invalid" }),
  ).toMatchObject(bad);
  expect(await request("/uploads", {})).toMatchObject(bad);
});
it("folderList returns owned project rows and the actual default-workspace flag", async () => {
  const result = await request("/folders");
  valid(workspaceApi.folderList, result);
  const row = result.data.find((item: { id: string }) => item.id === folder.id);
  expect(row).toEqual({
    ...db.prepare("SELECT * FROM folders WHERE id=?").get(folder.id)!,
    is_workspace: 0,
  });
  expect(await invalid("/folders")).toMatchObject(bad);
});
it("folderCreate preserves defaults and rejects slashes", async () => {
  expect(await request("/folders", { name: "bad/name" })).toMatchObject(bad);
  const result = await request("/folders", {
    name: "  Library child  ",
    parentId: folder.id,
  });
  valid(workspaceApi.folderCreate, result);
  expect(result.data).toEqual(
    db.prepare("SELECT * FROM folders WHERE id=?").get(result.data.id),
  );
  expect(result.data).toMatchObject({
    name: "Library child",
    parent_id: folder.id,
    kind: "folder",
  });
});
it("folderUpdate preserves ancestry protection and updates owned rows", async () => {
  const path = `/folders/${folder.id}`;
  expect(await request(path, { parentId: folder.id }, "PATCH")).toMatchObject(
    bad,
  );
  const result = await request(path, { name: "Library renamed" }, "PATCH");
  valid(workspaceApi.folderUpdate, result);
  expect(
    db.prepare("SELECT name FROM folders WHERE id=?").get(folder.id),
  ).toEqual({ name: "Library renamed" });
});
it("artifactList retains cursor, public columns and serialized metadata", async () => {
  const result = await request(`/artifacts?folder=${folder.id}`);
  valid(workspaceApi.artifactList, result);
  const row = db
    .prepare("SELECT *,rowid cursor FROM artifacts WHERE id=?")
    .get(artifact.id);
  expect(
    result.data.items.find((item: { id: string }) => item.id === artifact.id),
  ).toEqual({ ...row!, name: null, provider: null });
  expect(
    await request(`/artifacts?folder=${folder.id}&pinned=1&pinned=0`),
  ).toEqual(result);
  expect(
    (
      await request(
        `/artifacts?folder=${folder.id}&before=999999&before=999999`,
      )
    ).data.items,
  ).toEqual([]);
  expect(await invalid("/artifacts")).toMatchObject(bad);
});
it("artifactDetail projects the production artifact without decoding its metadata", async () => {
  const result = await request(`/artifacts/${artifact.id}`);
  valid(workspaceApi.artifactDetail, result);
  expect(result.data).toEqual(currentArtifact());
  expect(await invalid(`/artifacts/${artifact.id}`)).toMatchObject(bad);
});
it("artifactCreate keeps its id-only receipt and rejects private client metadata", async () => {
  expect(
    await request("/artifacts", {
      title: "Bad",
      content: "Text",
      metadata: { appResource: {} },
    }),
  ).toMatchObject(bad);
  const result = await request("/artifacts", {
    title: "Reusable library prompt",
    content: "Saved prompt",
    metadata: { snippet: true },
  });
  valid(workspaceApi.artifactCreate, result);
  expect(ownedArtifact(result.data.id, owner).metadata.snippet).toBe(true);
});
it("artifactCreate rejects kinds outside the owner-creatable set", async () => {
  for (const kind of ["code", "github_pr", "image", "conversation"]) {
    expect(
      await request("/artifacts", {
        title: "Bad kind",
        content: "Text",
        kind,
      }),
      kind,
    ).toMatchObject(bad);
  }
  const created = await request("/artifacts", {
    title: "Owner diagram",
    content: "```mermaid\nflowchart LR\na-->b\n```",
    kind: "diagram",
  });
  valid(workspaceApi.artifactCreate, created);
  const stored = ownedArtifact(created.data.id, owner);
  expect(stored.kind).toBe("diagram");
  expect(stored.role).toBe("snippet");
});
it("artifactUpdate preserves version checks and returns the updated artifact", async () => {
  const path = `/artifacts/${artifact.id}`,
    before = currentArtifact();
  expect(
    await request(path, { content: "Missing version" }, "PATCH"),
  ).toMatchObject(bad);
  const result = await request(
    path,
    { content: "Updated library contract", version: before.version },
    "PATCH",
  );
  valid(workspaceApi.artifactUpdate, result);
  expect(result.data).toEqual(currentArtifact());
  expect(
    (await request(path, { pinned: true, version: before.version }, "PATCH"))
      .status,
  ).toBe(409);
});
it("artifactMove preserves the operation identity and destination", async () => {
  expect(
    await request(`/artifacts/${artifact.id}/move`, { folderId: 42 }),
  ).toMatchObject(bad);
  const result = await request(`/artifacts/${artifact.id}/move`, {
    folderId: null,
  });
  valid(workspaceApi.artifactMove, result);
  expect(
    db
      .prepare("SELECT artifact_id FROM operations WHERE id=?")
      .get(result.data.operation),
  ).toEqual({ artifact_id: artifact.id });
  expect(currentArtifact().folder_id).toBeNull();
});
it("operationUndo restores a real move once and refuses an obsolete operation", async () => {
  const moved = await request(`/artifacts/${artifact.id}/move`, {
      folderId: folder.id,
    }),
    path = `/operations/${moved.data.operation}/undo`;
  expect(await invalid(path, "POST")).toMatchObject(bad);
  const result = await request(path, {});
  valid(workspaceApi.operationUndo, result);
  expect(currentArtifact().folder_id).toBeNull();
  expect((await request(path, {})).status).toBe(409);
});
it("runCheckout projects a captured Git checkout without internal capture coordination", async () => {
  const result = await request(`/runs/${run.id}/checkout`);
  valid(workspaceApi.runCheckout, result);
  const raw = checkoutDetail(owner, run.id)!;
  const {
    capture_token: _token,
    capture_started_at: _at,
    capture_pending: _pending,
    ...publicDetail
  } = raw as typeof raw & {
    capture_token: unknown;
    capture_started_at: unknown;
    capture_pending: unknown;
  };
  expect(result.data).toEqual(publicDetail);
  expect(result.data.state).toBe("captured");
  expect(
    result.data.files.find(
      (file: { path: string }) => file.path === "tracked.txt",
    ).filtered,
  ).toBe(true);
  expect(await invalid(`/runs/${run.id}/checkout`)).toMatchObject(bad);
});
it("runVerifications returns observed command exits and output tails", async () => {
  const result = await request(`/runs/${run.id}/verifications`);
  valid(workspaceApi.runVerifications, result);
  expect(result.data).toEqual(runVerifications(owner, run.id));
  expect(result.data).toHaveLength(1);
  expect(await invalid(`/runs/${run.id}/verifications`)).toMatchObject(bad);
});
it("runFiles returns published file metadata from production publication", async () => {
  const result = await request(`/runs/${run.id}/files`);
  valid(workspaceApi.runFiles, result);
  expect(result.data).toContainEqual(
    db
      .prepare("SELECT id,title,metadata FROM artifacts WHERE id=?")
      .get(published.artifactId),
  );
  expect(await invalid(`/runs/${run.id}/files`)).toMatchObject(bad);
});
it("objectFile retains bytes, attachment headers and sandboxed HTML previews", async () => {
  const path = `/objects/${uploaded.data.objectId}`;
  const result = await fetch(origin + "/api" + path);
  expect(result.status).toBe(200);
  expect(result.headers.get("content-disposition")).toContain("original.html");
  const blob = await result.blob();
  expect(workspaceApi.objectFile.response.parse(blob)).toBe(blob);
  expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes);
  const html = await fetch(origin + "/api" + path + "?preview=html");
  expect(html.status).toBe(200);
  expect(html.headers.get("content-type")).toContain("text/html");
  expect(html.headers.get("content-security-policy")).toContain("sandbox");
  expect(await invalid(path)).toMatchObject(bad);
});
it("search preserves excerpts and pagination while dropping retrieval internals", async () => {
  const result = await request("/search?q=library");
  valid(workspaceApi.search, result);
  expect(result.data.items.length).toBeGreaterThan(0);
  const actual = await search(owner, "library");
  const expected = JSON.parse(JSON.stringify(actual));
  for (const item of expected.items) {
    delete item.rank;
    delete item.vector;
  }
  expect(result.data).toEqual(expected);
  expect(await request("/search")).toMatchObject(bad);
  expect(
    (await request("/search?q=library&agent=a&agent=b&from=bad")).data,
  ).toEqual(result.data);
});
it("searchStatus returns the production index state", async () => {
  const result = await request("/search/status");
  valid(workspaceApi.searchStatus, result);
  expect(result.data).toEqual(searchStatus(owner));
  expect(await invalid("/search/status")).toMatchObject(bad);
});
it("preferences handles the absent row and projects only browser-read keys", async () => {
  const result = await request("/preferences");
  valid(workspaceApi.preferences, result);
  expect(result.data).toEqual({ embedding_enabled: 0 });
  expect(await invalid("/preferences")).toMatchObject(bad);
});
it("preferencesUpdate retains validation and persisted settings", async () => {
  expect(
    await request("/preferences", { embeddingEnabled: true }),
  ).toMatchObject(bad);
  const result = await request("/preferences", {
    embeddingEnabled: false,
    connectionId: null,
  });
  valid(workspaceApi.preferencesUpdate, result);
  expect(
    db
      .prepare(
        "SELECT embedding_enabled,embedding_connection FROM preferences WHERE owner_id=?",
      )
      .get(owner),
  ).toEqual({ embedding_enabled: 0, embedding_connection: null });
  const read = await request("/preferences");
  valid(workspaceApi.preferences, read);
  expect(Object.keys(read.data).sort()).toEqual([
    "embedding_connection",
    "embedding_enabled",
  ]);
});
it("importPreview retains new and duplicate receipts with their already-decoded summaries", async () => {
  valid(workspaceApi.importPreview, preview);
  expect(preview.data.summary.conversations).toBeGreaterThan(0);
  const duplicate = await multipart("/imports/preview", archive, "export.zip");
  valid(workspaceApi.importPreview, duplicate);
  expect(duplicate.data).toEqual({
    ...importRow()!,
    summary: JSON.parse((importRow() as { summary: string }).summary),
    duplicate: true,
  });
  expect(await request("/imports/preview", {})).toMatchObject(bad);
});
it("importList leaves stored summary JSON opaque", async () => {
  const result = await request("/imports");
  valid(workspaceApi.importList, result);
  expect(result.data).toContainEqual(importRow());
  expect(result.data[0].summary).toBeTypeOf("string");
  expect(await invalid("/imports")).toMatchObject(bad);
});
it("importStart retains new, active and completed branches", async () => {
  const path = `/imports/${importId}/start`;
  expect(await invalid(path, "POST")).toMatchObject(bad);
  const started = await request(path, {});
  valid(workspaceApi.importStart, started);
  const active = await request(path, {});
  valid(workspaceApi.importStart, active);
  expect(active.data.id).toBe(started.data.id);
  expect(active.data).toEqual(
    PublicRun.parse(
      db.prepare("SELECT * FROM runs WHERE id=?").get(started.data.id),
    ),
  );
  const claimed = claim("library-import")!;
  expect(claimed.id).toBe(started.data.id);
  await executeImport(claimed);
  transition(claimed, "completed");
  const completed = await request(path, {});
  valid(workspaceApi.importStart, completed);
  expect(completed.data).toEqual({ status: "completed" });
  const duplicate = await multipart("/imports/preview", archive, "export.zip");
  valid(workspaceApi.importPreview, duplicate);
  expect(duplicate.data.summary.attachmentsStored).toBe(true);
});
it("importCancel cancels only the owned job and its queued run", async () => {
  const staged = await stageImport(
    owner,
    Buffer.from(
      JSON.stringify([
        {
          uuid: "cancel-export",
          name: "Cancel",
          chat_messages: [
            { uuid: "message", sender: "human", text: "Cancel fixture" },
          ],
        },
      ]),
    ),
    "cancel.json",
  );
  const started = await request(`/imports/${staged.id}/start`, {}),
    path = `/imports/${staged.id}/cancel`;
  expect(await invalid(path, "POST")).toMatchObject(bad);
  const result = await request(path, {});
  valid(workspaceApi.importCancel, result);
  expect(
    db.prepare("SELECT state FROM runs WHERE id=?").get(started.data.id),
  ).toEqual({ state: "cancelled" });
  expect(
    db.prepare("SELECT status FROM imports WHERE id=?").get(staged.id),
  ).toEqual({ status: "cancelled" });
});
it("refuses the retired copy-only continuation route without creating work", async () => {
  const counts = () =>
    db
      .prepare(
        "SELECT (SELECT count(*) FROM conversations) conversations, (SELECT count(*) FROM runs) runs",
      )
      .get();
  const before = counts();
  const result = await request(
    `/conversations/${run.conversation_id}/continue`,
    {
      agentId: agent.id,
      messageIds: [message.id],
    },
  );
  expect(result.status).toBe(404);
  expect(counts()).toEqual(before);
});
it("conversationContinueStart dispatches the first prompt with selected context and returns a reply", async () => {
  const target = (
    await request("/agents", {
      name: "continuation-target",
      connectionId: connection.id,
      model: "fixture",
    })
  ).data;
  const input = "What can we do about the browser smoke?";
  const path = `/conversations/${run.conversation_id}/continue/start`;
  const body = {
    agentId: target.id,
    messageIds: [message.id],
    start: { input, idempotencyKey: id() },
  };
  expect(
    await request(path, { agentId: target.id, messageIds: [message.id] }),
  ).toMatchObject(bad);
  expect(
    await request(path, { ...body, start: { ...body.start, input: " " } }),
  ).toMatchObject(bad);
  expect(await request(path, { ...body, start: { input } })).toMatchObject(bad);
  const result = await request(path, body);
  valid(workspaceApi.conversationContinueStart, result);
  expect(result.data.runId).toEqual(expect.any(String));
  const dispatched = claim(
    "continuation-fixture",
    (candidate) => candidate.id === result.data.runId,
  )!;
  expect(dispatched).toMatchObject({
    conversation_id: result.data.id,
    agent_id: target.id,
    input,
  });
  let history: unknown;
  const restoreStream = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_secret, request) {
      history = request.messages;
      yield { text: "Run the browser smoke once the current check finishes." };
    },
  });
  try {
    expect(await executeAgent(dispatched)).toBe(true);
  } finally {
    restoreStream();
  }
  expect(history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "Library prompt" }),
      expect.objectContaining({ role: "user", content: input }),
    ]),
  );
  expect(
    db
      .prepare(
        "SELECT content FROM messages WHERE run_id=? AND role='assistant'",
      )
      .get(dispatched.id),
  ).toEqual({
    content: "Run the browser smoke once the current check finishes.",
  });
  transition(dispatched, "completed");
  // A lost acknowledgement, even after completion, returns the same work.
  expect(await request(path, body)).toEqual(result);
  expect(
    db
      .prepare("SELECT id FROM runs WHERE conversation_id=?")
      .all(result.data.id),
  ).toEqual([{ id: dispatched.id }]);
});
it("typed multipart and binary clients preserve bytes, repeated queries, response validation and cancellation", async () => {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("location", { href: origin + "/", origin, search: "" });
  vi.stubGlobal("window", new EventTarget());
  let attempts = 0;
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) => {
    attempts++;
    return realFetch(new URL(path, origin), init);
  });
  try {
    const uploaded = await callRoute(
      workspaceApi.uploadCreate,
      { body: {}, file: new Blob([bytes]), filename: "typed.html" },
      "",
    );
    const result = await fetchStream(
      workspaceApi.objectFile,
      { params: { id: uploaded.objectId }, query: { preview: ["1", "0"] } },
      "",
    );
    expect(result.headers.get("content-type")).toContain(
      "application/octet-stream",
    );
    expect(Buffer.from(await result.arrayBuffer())).toEqual(bytes);
    const before = attempts;
    await expect(
      callRoute(
        workspaceApi.uploadCreate,
        { body: { folderId: "invalid" }, file: new Blob([bytes]) },
        "",
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(attempts).toBe(before);
    const controller = new AbortController();
    controller.abort();
    await expect(
      callRoute(
        workspaceApi.uploadCreate,
        { body: {}, file: new Blob([bytes]) },
        "",
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      readRoute(workspaceApi.importList, {}, "", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(before);
  } finally {
    vi.unstubAllGlobals();
  }
});
it("hybrid search projects real indexed documents without embedding vectors", async () => {
  await request("/preferences", { embeddingEnabled: true, connectionId: null });
  db.prepare("UPDATE memory_sources SET eligible=0 WHERE owner_id=?").run(
    owner,
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
  try {
    await indexPending();
  } finally {
    clock.mockRestore();
  }
  const produced = await search(owner, "library");
  expect(produced.mode).toBe("hybrid");
  expect(produced.items.some((item) => "vector" in item)).toBe(true);
  const result = await request("/search?q=library");
  valid(workspaceApi.search, result);
  for (const item of result.data.items) {
    expect(item).not.toHaveProperty("vector");
    expect(item).not.toHaveProperty("rank");
  }
});
