import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { workspaceApi, type RouteContract } from "../src/shared/workspace-api";
import { ToolMailStatus } from "../src/shared/agent-mail";
import { DEFINITION_EXAMPLES } from "../src/shared/agent-definitions";
import { gitProject } from "./git-project";

const directory = mkdtempSync(join(tmpdir(), "loop-team-contracts-"));
const project = join(directory, "project");
mkdirSync(project);
gitProject(project);
writeFileSync(join(project, "tracked.txt"), "review this change");
process.env.LOOP_DATA_DIR = directory;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { app } = await import("../src/server/index");
const { nativeSessions } = await import("../src/server/native-sessions");
const { OWNER: owner } = await import("../src/server/workspace-identity");
const { closeExecution } = await import("../src/server/execution-client");
const { createAgent, ownedRun } = await import("../src/server/domain");
const { submit } = await import("../src/server/agent-runtime");
const { sendMail, mailStatus } = await import("../src/server/agent-mail");
const { seal } = await import("../src/server/secrets");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
async function request(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(origin + "/api" + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined };
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
const bad = { status: 400, data: { error: expect.any(String) } };
function valid(
  contract: RouteContract,
  result: Awaited<ReturnType<typeof request>>,
) {
  expect(result.status, JSON.stringify(result.data)).toBe(
    contract.status ?? 200,
  );
  expect(contract.response.parse(result.data)).toEqual(result.data);
}
const connection = id();
db.prepare(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)",
).run(
  connection,
  owner,
  seal("private-connection-key", owner),
  JSON.stringify([{ id: "fixture" }]),
  now(),
);
const agents = Array.from({ length: 3 }, (_, i) =>
  createAgent(owner, {
    name: `contract-agent-${i}`,
    connectionId: connection,
    model: "fixture",
  }),
);
const folder = (
  await request("/workspace/projects", {
    name: "Contract project",
    path: project,
  })
).data.id;
const teamInput = {
  name: "Contract team",
  managerId: agents[0].id,
  members: [agents[1].id],
};
const teamResult = await request("/teams", teamInput);
valid(workspaceApi.teamCreate, teamResult);
const team = teamResult.data;
const presetInput = {
  presetId: "code-review",
  name: "Contract reviewers",
  folderId: folder,
  selection: { connectionId: connection, model: "fixture" },
  idempotencyKey: id(),
};
const preset = await request("/teams/from-preset", presetInput);
valid(workspaceApi.teamFromPreset, preset);
const definitionId = id(),
  definitionPath = "/agent-definitions/" + definitionId;
const definition = await request(
  definitionPath,
  { markdown: DEFINITION_EXAMPLES.agent, version: 0 },
  "PUT",
);
valid(workspaceApi.definitionSave, definition);
const reviewInput = {
  folderId: folder,
  scope: "uncommitted",
  base: "HEAD",
  idempotencyKey: id(),
};
const review = await request(`/teams/${preset.data.id}/reviews`, reviewInput);
valid(workspaceApi.teamReview, review);
const mailRun = submit(owner, {
  agentId: agents[0].id,
  teamId: team.id,
  input: "Fixture mail sender",
  idempotencyKey: id(),
});
db.prepare(
  "UPDATE runs SET state='running',worker_id='fixture-worker' WHERE id=?",
).run(mailRun.id);
const run = ownedRun(mailRun.id, owner);
const mail = sendMail(run, id(), {
  to: agents[1].id,
  body: "Fixture team mail",
  scope: "team",
});

// Accidental storage additions must not become public response fields.
db.exec(
  "ALTER TABLE teams ADD COLUMN private_fixture TEXT; ALTER TABLE agent_definitions ADD COLUMN private_fixture TEXT",
);
db.prepare("UPDATE teams SET private_fixture='private-team-value'").run();
db.prepare(
  "UPDATE agent_definitions SET private_fixture='private-definition-value'",
).run();
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeExecution();
  await nativeSessions.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("teamList projects owned teams and keeps preset_config as text", async () => {
  const result = await request("/teams");
  valid(workspaceApi.teamList, result);
  expect(
    result.data.find((row: { id: string }) => row.id === preset.data.id)
      .preset_config,
  ).toEqual(expect.any(String));
  expect(JSON.stringify(result.data)).not.toContain("private-team-value");
  expect(await invalid("/teams")).toMatchObject(bad);
});
it("teamPresets returns the published roles", async () => {
  const result = await request("/team-presets");
  valid(workspaceApi.teamPresets, result);
  expect(
    result.data.find((row: { id: string }) => row.id === "code-review").roles,
  ).toHaveLength(4);
  expect(await invalid("/team-presets")).toMatchObject(bad);
});
it("teamCreate returns the committed team and rejects invalid members", async () => {
  valid(workspaceApi.teamCreate, teamResult);
  expect(
    db.prepare("SELECT conversation_id FROM teams WHERE id=?").get(team.id),
  ).toEqual({ conversation_id: team.conversation_id });
  expect(await request("/teams", { ...teamInput, members: [] })).toMatchObject(
    bad,
  );
});
it("teamFromPreset preserves the creation receipt", async () => {
  const again = await request("/teams/from-preset", presetInput);
  valid(workspaceApi.teamFromPreset, again);
  expect(again.data.id).toBe(preset.data.id);
  expect(
    await request("/teams/from-preset", {
      ...presetInput,
      presetId: "missing",
      idempotencyKey: id(),
    }),
  ).toMatchObject(bad);
});
it("teamMemberAdd returns updated membership", async () => {
  const path = `/teams/${team.id}/members`,
    result = await request(path, { agentId: agents[2].id });
  valid(workspaceApi.teamMemberAdd, result);
  expect(result.data.members).toContain(agents[2].id);
  expect(await request(path, { agentId: "" })).toMatchObject(bad);
});
it("teamFeedVisibility returns the persisted preference", async () => {
  const path = `/teams/${team.id}/feed-visibility`,
    result = await request(path, { hideResultsFromFeed: true }, "PATCH");
  valid(workspaceApi.teamFeedVisibility, result);
  expect(result.data.hide_results_from_feed).toBe(1);
  expect(
    await request(path, { hideResultsFromFeed: 1 }, "PATCH"),
  ).toMatchObject(bad);
});
it("teamDelete preserves an empty request and the Ok receipt", async () => {
  const extra = await request("/teams", { ...teamInput, name: "Delete team" });
  const path = `/teams/${extra.data.id}`;
  valid(workspaceApi.teamDelete, await request(path, undefined, "DELETE"));
  expect(
    db.prepare("SELECT deleted_at FROM teams WHERE id=?").get(extra.data.id),
  ).toMatchObject({ deleted_at: expect.any(Number) });
  expect(await invalid(path, "DELETE")).toMatchObject(bad);
});
it("teamReview captures a real repository and retains exact review identity on replay", async () => {
  const path = `/teams/${preset.data.id}/reviews`;
  const replay = await request(path, reviewInput);
  valid(workspaceApi.teamReview, replay);
  expect(replay.data).toEqual(review.data);
  const row = db
    .prepare("SELECT id,fingerprint,source_path FROM code_reviews WHERE id=?")
    .get(review.data.id) as { id: string; fingerprint: string };
  expect(replay.data).toMatchObject({
    id: row.id,
    fingerprint: row.fingerprint,
  });
  expect(replay.data).not.toHaveProperty("snapshot");
  expect(replay.data).not.toHaveProperty("source_path");
  expect(
    await request(path, { ...reviewInput, scope: "invalid" }),
  ).toMatchObject(bad);
});
it("teamReview rejects a stored result without its required conversation", async () => {
  db.prepare(
    "UPDATE runs SET conversation_id=NULL WHERE id=(SELECT run_id FROM code_reviews WHERE id=?)",
  ).run(review.data.id);
  try {
    expect(
      await request(`/teams/${preset.data.id}/reviews`, reviewInput),
    ).toEqual({
      status: 500,
      data: {
        error: "The workspace response is unavailable. Please try again.",
      },
    });
  } finally {
    db.prepare(
      "UPDATE runs SET conversation_id=? WHERE id=(SELECT run_id FROM code_reviews WHERE id=?)",
    ).run(review.data.conversationId, review.data.id);
  }
});
it("reviewStatus retains HTTP id, fingerprint and lead conversationId, including freshness and null", async () => {
  const path = `/reviews/conversation/${review.data.conversationId}`;
  const result = await request(path);
  valid(workspaceApi.reviewStatus, result);
  expect(result.data).toEqual(review.data);
  const fresh = await request(path + "?freshness=true");
  valid(workspaceApi.reviewStatus, fresh);
  expect(fresh.data.current).toBe(true);
  const absent = await request(`/reviews/conversation/${team.conversation_id}`);
  valid(workspaceApi.reviewStatus, absent);
  expect(absent.data).toBeNull();
  expect(await invalid(path)).toMatchObject(bad);
  expect(await request(path + "?freshness=true&freshness=false")).toMatchObject(
    bad,
  );
});
it.each([
  ["teamMessages", `/teams/${team.id}/messages`],
  ["agentMail", `/agents/${agents[0].id}/mail`],
] as const)(
  "%s shares mail states with the privacy-filtered tool projection",
  async (name, path) => {
    const result = await request(path);
    valid(workspaceApi[name], result);
    const thread = result.data.threads.find(
      (row: { id: string }) => row.id === mail.threadId,
    );
    const status = mailStatus(run, { threadId: mail.threadId });
    expect(ToolMailStatus.parse(status)).toEqual(status);
    if (!("messages" in status)) throw new Error("Missing thread detail");
    expect(thread).toMatchObject({
      scope: status.scope,
      subject: status.subject,
    });
    expect(thread.messages[0]).toMatchObject({
      id: status.messages[0].messageId,
      status: status.messages[0].status,
    });
    expect(thread).not.toHaveProperty("owner_id");
    expect(thread.messages[0]).not.toHaveProperty("request");
    expect(await invalid(path)).toMatchObject(bad);
  },
);
it.each([
  ["teamThreadResume", `/teams/${team.id}/threads/${mail.threadId}/resume`],
  ["agentMailResume", `/agents/${agents[0].id}/mail/${mail.threadId}/resume`],
] as const)(
  "%s resumes only the selected thread and preserves counts",
  async (name, path) => {
    db.prepare(
      "UPDATE agent_threads SET paused_at=?,paused_reason='fixture pause' WHERE id=?",
    ).run(now(), mail.threadId);
    const result = await request(path, {});
    valid(workspaceApi[name], result);
    expect(result.data).toEqual({ released: 0, refused: 0, held: 0 });
    expect(
      db
        .prepare("SELECT paused_at FROM agent_threads WHERE id=?")
        .get(mail.threadId),
    ).toEqual({ paused_at: null });
    expect(await invalid(path, "POST")).toMatchObject(bad);
  },
);
it("definitionList projects saved summaries without private columns or Markdown", async () => {
  const result = await request("/agent-definitions");
  valid(workspaceApi.definitionList, result);
  expect(result.data[0]).toMatchObject({
    id: definitionId,
    name: "code-reviewer",
  });
  expect(result.data[0]).not.toHaveProperty("markdown");
  expect(result.data[0]).not.toHaveProperty("owner_id");
  expect(await invalid("/agent-definitions")).toMatchObject(bad);
});
it("definitionRead returns original Markdown and parsed public roles", async () => {
  const result = await request(definitionPath);
  valid(workspaceApi.definitionRead, result);
  expect(result.data.markdown).toBe(DEFINITION_EXAMPLES.agent);
  expect(result.data.spec.instructions).toContain("You are a code reviewer");
  expect(JSON.stringify(result.data)).not.toContain("private-definition-value");
  expect(await invalid(definitionPath)).toMatchObject(bad);
});
it("definitionSave preserves Markdown and handler frontmatter/byte/version validation", async () => {
  valid(workspaceApi.definitionSave, definition);
  expect(
    await request(
      definitionPath,
      { version: 1, markdown: "No frontmatter" },
      "PUT",
    ),
  ).toMatchObject(bad);
  expect(
    await request(
      definitionPath,
      { version: 1, markdown: "😀".repeat(40_000) },
      "PUT",
    ),
  ).toMatchObject(bad);
  expect(
    (
      await request(
        definitionPath,
        { version: 5, markdown: DEFINITION_EXAMPLES.agent },
        "PUT",
      )
    ).status,
  ).toBe(409);
});
it("definitionCreate returns agent, team and combined branches with durable receipts", async () => {
  const input = {
    version: 1,
    selection: { connectionId: connection, model: "fixture" },
    idempotencyKey: id(),
  };
  const path = definitionPath + "/create",
    result = await request(path, input);
  valid(workspaceApi.definitionCreate, result);
  expect(result.data.agent.name).toBe("code-reviewer");
  expect((await request(path, input)).data).toEqual(result.data);
  const teamDef = "/agent-definitions/" + id();
  await request(
    teamDef,
    { markdown: DEFINITION_EXAMPLES.team, version: 0 },
    "PUT",
  );
  const teamCreated = await request(teamDef + "/create", {
    ...input,
    idempotencyKey: id(),
  });
  valid(workspaceApi.definitionCreate, teamCreated);
  expect(teamCreated.data.team.members).toHaveLength(1);
  expect(teamCreated.data.agent).toBeUndefined();
  const combined = await request(path, {
    ...input,
    name: "added-definition-worker",
    teamId: team.id,
    idempotencyKey: id(),
  });
  valid(workspaceApi.definitionCreate, combined);
  expect(combined.data.team.members).toContain(combined.data.agent.id);
  expect(await request(path, { ...input, version: 0 })).toMatchObject(bad);
});
it("definitionCreate rejects an empty stored result without repeating creation", async () => {
  const input = {
    version: 1,
    name: "invalid-receipt-fixture",
    selection: { connectionId: connection, model: "fixture" },
    idempotencyKey: id(),
  };
  const path = definitionPath + "/create";
  valid(workspaceApi.definitionCreate, await request(path, input));
  const count = () =>
    db.prepare("SELECT count(*) AS n FROM agents WHERE owner_id=?").get(owner);
  const before = count();
  db.prepare(
    "UPDATE definition_creations SET agent_id=NULL,team_id=NULL WHERE owner_id=? AND request_key=?",
  ).run(owner, input.idempotencyKey);
  expect(await request(path, input)).toEqual({
    status: 500,
    data: { error: "The workspace response is unavailable. Please try again." },
  });
  expect(count()).toEqual(before);
});
it("definitionDelete checks the current version", async () => {
  const path = "/agent-definitions/" + id();
  await request(
    path,
    { markdown: DEFINITION_EXAMPLES.agent, version: 0 },
    "PUT",
  );
  expect(await request(path, { version: 0 }, "DELETE")).toMatchObject(bad);
  valid(
    workspaceApi.definitionDelete,
    await request(path, { version: 1 }, "DELETE"),
  );
  expect((await request(path)).status).toBe(404);
});
it("sharePreview preserves routed and unrouted branches with optional source", async () => {
  for (const question of [
    "An untagged question",
    `@${agents[0].name} a question`,
  ]) {
    const result = await request("/share/preview", { question });
    valid(workspaceApi.sharePreview, result);
    expect(result.data.mode).toBe(
      question.startsWith("@") ? "queue" : "create",
    );
    expect(result.data).not.toHaveProperty("source");
  }
  const result = await request("/share/preview", {
    question: "Read this",
    source: { url: "https://example.com" },
  });
  valid(workspaceApi.sharePreview, result);
  expect(result.data.source).toEqual({
    url: "https://example.com",
    title: "",
    excerpt: "",
  });
  expect(await request("/share/preview", { question: "" })).toMatchObject(bad);
});
it("shareSend returns a production run and does not replay an idempotent send", async () => {
  const input = {
    question: `@${agents[0].name} read this`,
    idempotencyKey: id(),
  };
  const result = await request("/share/send", input);
  valid(workspaceApi.shareSend, result);
  expect((await request("/share/send", input)).data.id).toBe(result.data.id);
  expect(
    await request("/share/send", { ...input, idempotencyKey: "short" }),
  ).toMatchObject(bad);
});
it("routingPreview selects a public agent without leaking connection credentials", async () => {
  const result = await request("/routing/preview", {
    input: `@${agents[0].name} work`,
  });
  valid(workspaceApi.routingPreview, result);
  expect(result.data.agent.id).toBe(agents[0].id);
  expect(JSON.stringify(result.data)).not.toContain("private-connection-key");
  expect(await request("/routing/preview", { input: "" })).toMatchObject(bad);
});
const push = {
  endpoint: "https://fcm.googleapis.com/contract-fixture",
  keys: {
    p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString(
      "base64url",
    ),
    auth: randomBytes(16).toString("base64url"),
  },
};
it("notificationSubscribe accepts inbound keys but returns only an Ok receipt", async () => {
  const result = await request("/notifications/subscriptions", push);
  valid(workspaceApi.notificationSubscribe, result);
  expect(result.data).toEqual({ ok: true });
  expect(
    await request("/notifications/subscriptions", {
      ...push,
      keys: { ...push.keys, auth: "invalid" },
    }),
  ).toMatchObject(bad);
});
it("notifications returns preferences and a VAPID public key, never subscription keys or private keys", async () => {
  await request("/notifications/subscriptions", push);
  const result = await request("/notifications");
  valid(workspaceApi.notifications, result);
  expect(result.data.endpoints).toContain(push.endpoint);
  const text = JSON.stringify(result.data);
  expect(text).not.toContain(push.keys.auth);
  expect(text).not.toContain(push.keys.p256dh);
  expect(text).not.toMatch(/private_key|privateKey|subscription|p256dh|"auth"/);
  expect(result.data.devices[0].preferences).toEqual({
    needsYou: true,
    completed: true,
    reminders: true,
    social: true,
  });
  expect(await invalid("/notifications")).toMatchObject(bad);
});
it("notificationUnsubscribe removes only the named endpoint", async () => {
  valid(
    workspaceApi.notificationUnsubscribe,
    await request(
      "/notifications/subscriptions",
      { endpoint: push.endpoint },
      "DELETE",
    ),
  );
  expect((await request("/notifications")).data.endpoints).not.toContain(
    push.endpoint,
  );
  expect(
    await request(
      "/notifications/subscriptions",
      { endpoint: "http://localhost/private" },
      "DELETE",
    ),
  ).toMatchObject(bad);
});
it("viewportDiagnostics validates numeric-only geometry and keeps the empty 204 response", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const input = {
      session: id(),
      samples: [
        {
          elapsed: 1,
          viewport: Array(9).fill(0),
          dialog: [],
          header: [],
          input: [],
          body: [],
          flags: Array(8).fill(0),
        },
      ],
    };
    valid(
      workspaceApi.viewportDiagnostics,
      await request("/ui/viewport-diagnostics", input),
    );
    expect(info).toHaveBeenCalledWith(
      "loop-viewport-diagnostics",
      JSON.stringify(input),
    );
    expect(
      await request("/ui/viewport-diagnostics", {
        ...input,
        text: "private form contents",
      }),
    ).toMatchObject(bad);
    expect(info).toHaveBeenCalledTimes(1);
  } finally {
    info.mockRestore();
  }
});
