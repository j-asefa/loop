import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { workspaceApi, type RouteContract } from "../src/shared/workspace-api";
import { callRoute, fetchStream, routeUrl } from "../src/client/workspace-api";

const directory = mkdtempSync(join(tmpdir(), "loop55-personal-contracts-"));
process.env.LOOP55_DATA_DIR = directory;
process.env.LOOP55_PROFILE = "companion";
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id } = await import("../src/server/db");
const { app } = await import("../src/server/index");
const { withTestAdapter } = await import("../src/server/providers");
const { nativeSessions } = await import("../src/server/native-sessions");
const { closeExecution } = await import("../src/server/execution-client");
const { submit } = await import("../src/server/agent-runtime");
const { claim, transition } = await import("../src/server/queue");
const { recordConversationUpdate } =
  await import("../src/server/conversation-updates");
const { storePublishedFile } = await import("../src/server/published-files");
const { saveArtifact } = await import("../src/server/artifacts");
const { personalFiles } = await import("../src/server/personal-files");
const { personalHistory } = await import("../src/server/personal-history");
const { personalDecisions } = await import("../src/server/personal-decisions");
const { readProfile, saveProfile } = await import("../src/server/user-profile");
const { requestApproval, decide } = await import("../src/server/approvals");
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
async function invalidBody(path: string) {
  return new Promise<{ status: number; data: unknown }>((resolve, reject) => {
    const req = httpRequest(
      origin + "/api" + path,
      {
        method: "GET",
        headers: { "content-type": "application/json", "content-length": "2" },
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
    req.end("{}");
  });
}
function valid(
  contract: RouteContract,
  result: Awaited<ReturnType<typeof request>>,
) {
  expect(result.status, JSON.stringify(result.data)).toBe(
    contract.status ?? 200,
  );
  // No public fields emitted by these producers are removed by the projection.
  expect(contract.response.parse(result.data)).toEqual(result.data);
}
const bad = { status: 400, data: { error: expect.any(String) } };
const connection = await request("/connections", {
  provider: "openai",
  label: "Fixture",
  secret: "fixture-private-key",
});
const created = await request("/agents", {
  name: "personal-contract",
  connectionId: connection.data.id,
  model: "fixture",
});
expect(created.status).toBe(201);
const agent = created.data;
const queued = submit(owner, {
  agentId: agent.id,
  input: "Personal contract prompt",
  personal: true,
  idempotencyKey: id(),
});
const run = claim("contract-fixture")!;
expect(run.id).toBe(queued.id);
const message = recordConversationUpdate(run, "contract-output", {
  content: "Recorded contract output",
  metadata: { final: true },
})!;
const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aocsAAAAASUVORK5CYII=",
  "base64",
);
const png = storePublishedFile(run, id(), {
  name: "result (1).png",
  title: "Contract image",
  mime: "image/png",
  bytes: pngBytes,
});
const html = storePublishedFile(run, id(), {
  name: "preview.html",
  title: "Contract preview",
  mime: "text/html",
  bytes: Buffer.from("<p>Published preview</p>"),
});
const foreign = saveArtifact("other-owner", {
  title: "Private",
  content: "Private",
});
const approval = requestApproval(run, {
  tool: "fixture",
  arguments: { label: "Visible decision" },
});
expect(transition(run, "awaiting_approval")).toBe(true);
decide(owner, approval.id, "approve");
saveProfile("other-owner", {
  display_name: "Other",
  handle: "other_owner",
  bio: "Private",
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

it("messageSearch projects real message rows, keeps metadata text, and rejects oversized queries", async () => {
  const result = await request("/messages?q=contract");
  valid(workspaceApi.messageSearch, result);
  const rows = db
    .prepare(
      "SELECT * FROM messages WHERE owner_id=? AND instr(lower(content),'contract')>0 ORDER BY created_at DESC LIMIT 50",
    )
    .all(owner);
  expect(result.data).toEqual(rows);
  expect(
    result.data.find((item: { id: string }) => item.id === message.id).metadata,
  ).toBeTypeOf("string");
  expect(await request("/messages?q=" + "x".repeat(501))).toMatchObject(bad);
});
it("messageDetail returns the recorded message and rejects a GET body", async () => {
  const result = await request(`/messages/${message.id}`);
  valid(workspaceApi.messageDetail, result);
  expect(result.data).toEqual(
    db.prepare("SELECT * FROM messages WHERE id=?").get(message.id),
  );
  expect(await invalidBody(`/messages/${message.id}`)).toMatchObject(bad);
  expect((await request("/messages/unknown")).status).toBe(404);
});
it("resultUpdate requires hidden, preserves unrelated fields, and enforces artifact ownership", async () => {
  const result = await request(
    `/results/${png.artifactId}`,
    { hidden: true, title: "Ignored" },
    "PATCH",
  );
  valid(workspaceApi.resultUpdate, result);
  expect(
    db
      .prepare("SELECT feed_hidden,title FROM artifacts WHERE id=?")
      .get(png.artifactId),
  ).toEqual({ feed_hidden: 1, title: "Contract image" });
  expect(
    await request(`/results/${png.artifactId}`, {}, "PATCH"),
  ).toMatchObject(bad);
  expect(
    await request(`/results/${png.artifactId}`, { hidden: "yes" }, "PATCH"),
  ).toMatchObject(bad);
  expect(
    (await request(`/results/${foreign}`, { hidden: true }, "PATCH")).status,
  ).toBe(404);
});
it("artifactFile preserves bytes, attachment/preview policies and owner checks", async () => {
  for (const [query, disposition] of [
    ["", "attachment"],
    ["?preview=1", "inline"],
    ["?preview=other", "attachment"],
    ["?preview=1&preview=html", "attachment"],
  ]) {
    const response = await fetch(origin + png.downloadUrl + query);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe(
      `${disposition}; filename*=UTF-8''result%20%281%29.png`,
    );
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const blob = await response.blob();
    expect(workspaceApi.artifactFile.response.parse(blob)).toBe(blob);
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(pngBytes);
  }
  const preview = await fetch(origin + html.downloadUrl + "?preview=html");
  expect(preview.headers.get("content-security-policy")).toContain(
    "sandbox allow-scripts",
  );
  expect(preview.headers.get("content-security-policy")).not.toContain(
    "allow-same-origin",
  );
  expect(await preview.text()).toBe("<p>Published preview</p>");
  expect(await invalidBody(`/artifacts/${png.artifactId}/file`)).toMatchObject(
    bad,
  );
  expect((await request(`/artifacts/${foreign}/file`)).status).toBe(404);
});
it("artifactDownload preserves its owner-checked 303 and the typed client follows it to bytes", async () => {
  const response = await fetch(
    origin + `/api/artifacts/${png.artifactId}/download`,
    { redirect: "manual" },
  );
  expect(response.status).toBe(workspaceApi.artifactDownload.status);
  expect(response.headers.get("location")).toBe(png.downloadUrl);
  expect(
    await invalidBody(`/artifacts/${png.artifactId}/download`),
  ).toMatchObject(bad);
  expect((await request(`/artifacts/${foreign}/download`)).status).toBe(404);
  const realFetch = globalThis.fetch;
  vi.stubGlobal("location", { href: origin + "/", origin, search: "" });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) =>
    realFetch(new URL(path, origin), init),
  );
  try {
    const blob = await callRoute(
      workspaceApi.artifactDownload,
      { params: { id: png.artifactId } },
      "",
    );
    expect(workspaceApi.artifactDownload.response.parse(blob)).toBe(blob);
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(pngBytes);
    const address = routeUrl(
      workspaceApi.artifactFile,
      { params: { id: png.artifactId }, query: { preview: "1" } },
      "",
    );
    expect((await fetch(address)).headers.get("content-disposition")).toMatch(
      /^inline;/,
    );
    const file = await fetchStream(
      workspaceApi.artifactFile,
      { params: { id: png.artifactId } },
      "",
    );
    expect(file.headers.get("content-disposition")).toContain(
      "result%20%281%29.png",
    );
    expect(Buffer.from(await file.arrayBuffer())).toEqual(pngBytes);
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchStream(
        workspaceApi.artifactFile,
        { params: { id: png.artifactId } },
        "",
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    vi.unstubAllGlobals();
  }
});
it("personalFiles projects published rows and preserves filters, choices and query validation", async () => {
  const result = await request("/me/files");
  valid(workspaceApi.personalFiles, result);
  expect(result.data).toEqual(personalFiles(owner, {}));
  expect(result.data.items.map((item: { id: string }) => item.id)).toEqual([
    html.artifactId,
    png.artifactId,
  ]);
  const filtered = await request("/me/files?type=image&q=%20contract%20");
  valid(workspaceApi.personalFiles, filtered);
  expect(filtered.data.items[0].id).toBe(png.artifactId);
  expect(filtered.data.items).toHaveLength(1);
  expect(await request("/me/files?before=0")).toMatchObject(bad);
  expect(await request("/me/files?type=pdf")).toMatchObject(bad);
});
it("personalDecisions projects a production approval receipt and rejects malformed queries/cursors", async () => {
  const result = await request("/me/decisions?kind=approval");
  valid(workspaceApi.personalDecisions, result);
  expect(result.data).toEqual(personalDecisions(owner, { kind: "approval" }));
  expect(result.data.items[0]).toMatchObject({
    choice: "approve",
    conversation_id: run.conversation_id,
  });
  expect(await request("/me/decisions?kind=anything")).toMatchObject(bad);
  expect(
    await request("/me/decisions?kind=approval&before=invalid"),
  ).toMatchObject(bad);
});
it("personalApproval reopens the original recorded request through the companion API", async () => {
  expect((await request("/capabilities")).data.personalApprovalDetails).toBe(
    true,
  );
  const result = await request(`/me/approvals/approval:${approval.id}`);
  valid(workspaceApi.personalApproval, result);
  expect(result.data).toEqual({
    source: "approval",
    request: { tool: "fixture", arguments: { label: "Visible decision" } },
  });
  const missing = await request("/me/approvals/approval:missing");
  expect(missing).toEqual({
    status: 404,
    data: { error: "Approval history not found" },
  });
  const spec = JSON.parse(readFileSync("docs/openapi.json", "utf8"));
  expect(
    spec.paths["/api/me/approvals/{id}"].get.responses[missing.status].content[
      "application/json"
    ].schema,
  ).toEqual({ $ref: "#/components/schemas/Error" });
});
it("personalProfile returns only the authenticated owner's profile and live counts", async () => {
  const result = await request("/me/profile?owner=other-owner");
  valid(workspaceApi.personalProfile, result);
  expect(result.data).toEqual(readProfile(owner));
  expect(result.data).toMatchObject({
    display_name: null,
    handle: null,
    bio: null,
    counts: { messages: 1, agents: 1, projects: 0 },
  });
  expect(await invalidBody("/me/profile")).toMatchObject(bad);
});
it("personalProfileUpdate preserves normalization, clearing and handle conflicts", async () => {
  const result = await request(
    "/me/profile",
    {
      display_name: "  Name  ",
      handle: " @Name_1 ",
      bio: " About ",
      owner: "other-owner",
    },
    "PUT",
  );
  valid(workspaceApi.personalProfileUpdate, result);
  expect(result.data).toEqual(readProfile(owner));
  expect(result.data).toMatchObject({
    display_name: "Name",
    handle: "name_1",
    bio: "About",
  });
  expect(readProfile("other-owner").display_name).toBe("Other");
  expect(
    await request(
      "/me/profile",
      { display_name: null, handle: "?", bio: null },
      "PUT",
    ),
  ).toMatchObject(bad);
  expect(await request("/me/profile", {}, "PUT")).toMatchObject(bad);
  expect(
    (
      await request(
        "/me/profile",
        { display_name: "Name", handle: "other_owner", bio: "" },
        "PUT",
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        "/me/profile",
        { display_name: " ", handle: "", bio: null },
        "PUT",
      )
    ).data,
  ).toMatchObject({ display_name: null, handle: null, bio: null });
});
it("personalPrompts projects a production personal send and validates search/cursor bounds", async () => {
  const result = await request("/me/prompts?q=%20contract%20");
  valid(workspaceApi.personalPrompts, result);
  expect(result.data).toEqual(personalHistory(owner, undefined, "contract"));
  expect(result.data.items[0]).toMatchObject({
    content: "Personal contract prompt",
    attachments: [],
    agent_id: agent.id,
  });
  expect(await request("/me/prompts?before=invalid")).toMatchObject(bad);
  expect(await request("/me/prompts?q=" + "x".repeat(201))).toMatchObject(bad);
});
