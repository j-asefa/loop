import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";

const dir = mkdtempSync(join(tmpdir(), "loop-mcp-import-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { mcp } = await import("../src/server/mcp/routes");
const { withTestMcp, readSecret, connectionUrl, discover } =
  await import("../src/server/mcp/client");
const { migrateMcpUrlCredentials } =
  await import("../src/server/mcp/credentials");
const { MCP_TOOL_BUDGET, workspaceToolBindings, ToolBudgetError } =
  await import("../src/server/mcp/tool-budget");
const { redactCredentials } = await import("../src/server/mcp/redaction");
const { enqueue } = await import("../src/server/queue");
const { requestApproval } = await import("../src/server/approvals");

const app = express();
app.use(express.json(), (req, res, next) => {
  res.locals.owner = req.get("x-owner");
  next();
});
app.use(mcp);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.status || 500).json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const base = "http://127.0.0.1:" + (server.address() as any).port;
async function api(
  owner: string,
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-owner": owner },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}
const record = (key: string) =>
  db.prepare("SELECT * FROM mcp_connections WHERE id=?").get(key) as any;
const smallTool = (name: string) => ({
  name,
  inputSchema: { type: "object", properties: {} },
});
function fixture(tools: unknown[], observe: (c: any) => void = () => {}) {
  return withTestMcp(async (c) => {
    observe(c);
    return {
      getServerCapabilities: () => ({ tools: {} }),
      getServerVersion: () => ({ name: "Fixture", version: "1" }),
      listTools: async () => ({ tools }),
      close: async () => {},
    } as any;
  });
}
function insert(owner: string, tools: unknown[], status = "connected") {
  const key = id();
  db.prepare(
    "INSERT INTO mcp_connections(id,owner_id,name,url,secret,tools,status,created_at) VALUES(?,?,'Fixture','https://fixture.example/mcp',?,?,?,?)",
  ).run(
    key,
    owner,
    seal('{"type":"none"}', owner),
    JSON.stringify(tools),
    status,
    now(),
  );
  return key;
}
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("persists owner-scoped approval preferences and resumes only current MCP calls on connected servers", async () => {
  const owner = id(),
    other = id();
  const connection = insert(owner, []),
    foreign = insert(other, []),
    disabled = insert(owner, [], "disabled");
  function waiting(
    who: string,
    connectionId: string,
    type = "mcp_tool",
    expired = false,
  ) {
    const run = enqueue(who, "Policy fixture", id());
    const approval = requestApproval(run, {
      type,
      connectionId,
      tool: "fixture",
    });
    db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(
      run.id,
    );
    if (expired)
      db.prepare("UPDATE approvals SET expires_at=? WHERE id=?").run(
        now() - 1,
        approval.id,
      );
    return approval;
  }
  const active = waiting(owner, connection);
  const excluded = [
    waiting(other, foreign),
    waiting(owner, disabled),
    waiting(owner, connection, "mcp_install"),
    waiting(owner, connection, "workflow_review"),
    waiting(owner, connection, "mcp_tool", true),
  ];
  expect((await api(owner, "/mcp/preferences")).data.approvalMode).toBe("ask");
  expect(
    (await api(owner, "/mcp/preferences", { approvalMode: "allow" }, "PUT"))
      .data,
  ).toEqual({ approvalMode: "allow", resumed: 1 });
  expect((await api(owner, "/mcp/preferences")).data.approvalMode).toBe(
    "allow",
  );
  expect((await api(other, "/mcp/preferences")).data.approvalMode).toBe("ask");
  expect(
    db.prepare("SELECT state FROM runs WHERE id=?").get(active.run_id),
  ).toEqual({ state: "queued" });
  for (const approval of excluded)
    expect(
      db.prepare("SELECT state FROM approvals WHERE id=?").get(approval.id),
    ).toEqual({ state: "pending" });
  expect(
    (await api(owner, "/mcp/preferences", { approvalMode: "allow" }, "PUT"))
      .data.resumed,
  ).toBe(0);
  expect(
    (await api(owner, "/mcp/preferences", { approvalMode: "ask" }, "PUT")).data
      .approvalMode,
  ).toBe("ask");
});

it("encrypts imported query credentials alongside headers, preserving repeated parameters only on outbound URLs", async () => {
  const owner = id(),
    key = 'query fixture+/&"',
    header = "fixture-header-key";
  const url = `https://fixture.example/mcp?api_key=${encodeURIComponent(key)}&scope=fixture-one&scope=fixture-two`;
  let outbound: URL | undefined;
  const restore = fixture([smallTool("inspect")], (c) => {
    outbound = connectionUrl(c);
  });
  try {
    const input = {
      config: {
        mcpServers: { Fixture: { url, headers: { "X-Api-Key": header } } },
      },
    };
    const installed = await api(owner, "/mcp/install", input);
    expect(installed.status).toBe(201);
    const connection = record(installed.data[0].id);
    expect(connection.url).toBe("https://fixture.example/mcp");
    expect(readSecret(connection)).toEqual({
      type: "headers",
      headers: { "X-Api-Key": header },
      query: { api_key: key, scope: ["fixture-one", "fixture-two"] },
    });
    expect(outbound!.searchParams.get("api_key")).toBe(key);
    expect(outbound!.searchParams.getAll("scope")).toEqual([
      "fixture-one",
      "fixture-two",
    ]);
    const publicRecords = await api(owner, "/mcp");
    for (const value of [
      key,
      header,
      encodeURIComponent(key),
      "fixture-one",
      "fixture-two",
    ])
      expect(
        JSON.stringify([connection, installed, publicRecords]),
      ).not.toContain(value);
    expect(publicRecords.data[0]).not.toHaveProperty("secret");
    expect((await api(owner, "/mcp/install", input)).data[0].id).toBe(
      connection.id,
    );
    expect(
      redactCredentials(outbound!.toString(), [readSecret(connection)]),
    ).not.toContain(encodeURIComponent(key));
    await api(
      owner,
      `/mcp/${connection.id}`,
      { action: "credentials", auth: { type: "bearer", token: "replacement" } },
      "PATCH",
    );
    expect(readSecret(record(connection.id)).query?.api_key).toBe(key);
  } finally {
    restore();
  }
});

it("keeps credentials out of manual connection responses and repairs earlier records idempotently", async () => {
  const owner = id();
  const manual = await api(owner, "/mcp", {
    name: "Manual",
    url: "https://fixture.example/mcp?token=manual-secret",
    auth: { type: "none" },
  });
  expect(manual.status).toBe(201);
  expect(manual.data.url).toBe("https://fixture.example/mcp");
  expect(JSON.stringify(manual.data)).not.toContain("manual-secret");
  const legacy = insert(owner, []),
    disconnected = insert(owner, [], "disconnected");
  db.prepare("UPDATE mcp_connections SET url=?,secret=? WHERE id=?").run(
    "https://fixture.example/mcp?key=old-secret&scope=a&scope=b",
    seal(
      JSON.stringify({
        type: "oauth",
        tokens: { access_token: "oauth-secret" },
      }),
      owner,
    ),
    legacy,
  );
  db.prepare("UPDATE mcp_connections SET url=? WHERE id=?").run(
    "https://fixture.example/mcp?key=forgotten-secret",
    disconnected,
  );
  migrateMcpUrlCredentials();
  const clean = record(legacy);
  expect(clean.status).toBe("connected");
  expect(readSecret(clean)).toMatchObject({
    type: "oauth",
    tokens: { access_token: "oauth-secret" },
    query: { key: "old-secret", scope: ["a", "b"] },
  });
  expect(readSecret(record(disconnected))).toEqual({ type: "none" });
  expect(
    (await api(owner, "/mcp")).data.every((c: any) => !c.url.includes("?")),
  ).toBe(true);
  migrateMcpUrlCredentials();
  expect(record(legacy)).toEqual(clean);
});

it("enforces the aggregate tool count at install and re-enable without affecting other owners or connected tools", async () => {
  const owner = id(),
    other = id();
  insert(
    other,
    Array.from({ length: 120 }, (_, i) => smallTool("other_" + i)),
  );
  const original = insert(
    owner,
    Array.from({ length: 119 }, (_, i) => smallTool("tool_" + i)),
  );
  const restore = fixture([smallTool("new_one"), smallTool("new_two")]);
  try {
    const installed = (
      await api(owner, "/mcp/install", {
        config: { mcpServers: { Extra: { url: "https://extra.example/mcp" } } },
      })
    ).data[0];
    expect(installed).toMatchObject({
      status: "disabled",
      error: expect.stringContaining("Disable unused integrations"),
    });
    expect(record(installed.id).status).toBe("disabled");
    expect(workspaceToolBindings(owner)).toHaveLength(119);
    const enabled = await api(
      owner,
      `/mcp/${installed.id}`,
      { action: "enable" },
      "PATCH",
    );
    expect(enabled.status).toBe(422);
    expect(record(original).status).toBe("connected");
    expect(record(installed.id).status).toBe("disabled");
    await api(owner, `/mcp/${original}`, { action: "disable" }, "PATCH");
    expect(
      (await api(owner, `/mcp/${installed.id}`, { action: "enable" }, "PATCH"))
        .status,
    ).toBe(200);
    expect(workspaceToolBindings(owner)).toHaveLength(2);
    expect(workspaceToolBindings(other)).toHaveLength(MCP_TOOL_BUDGET.count);
  } finally {
    restore();
  }
});

it("bounds serialized catalog bytes across connections, including Unicode, and guards legacy oversized workspaces", async () => {
  const owner = id();
  const large = Array.from({ length: 8 }, (_, i) => ({
    name: "large_" + i,
    inputSchema: { type: "object", description: "界".repeat(9000) },
  }));
  insert(owner, large);
  const candidate = insert(owner, [], "disabled");
  const restore = fixture(large);
  try {
    await expect(discover(record(candidate))).rejects.toBeInstanceOf(
      ToolBudgetError,
    );
    expect(record(candidate).status).toBe("disabled");
    expect(workspaceToolBindings(owner)).toHaveLength(8);
    // Records accepted by older versions fail before reaching a provider.
    db.prepare(
      "UPDATE mcp_connections SET tools=?,status='connected' WHERE id=?",
    ).run(JSON.stringify(large), candidate);
    expect(() => workspaceToolBindings(owner)).toThrow(ToolBudgetError);
  } finally {
    restore();
  }
});

it("serializes competing discoveries so only a catalog fitting the workspace can activate", async () => {
  const owner = id();
  insert(
    owner,
    Array.from({ length: 119 }, (_, i) => smallTool("old_" + i)),
  );
  const candidates = [
    insert(owner, [], "disabled"),
    insert(owner, [], "disabled"),
  ];
  const restore = fixture([smallTool("extra")]);
  try {
    const results = await Promise.allSettled(
      candidates.map((key) => discover(record(key))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(candidates.map((key) => record(key).status).sort()).toEqual([
      "connected",
      "disabled",
    ]);
    expect(workspaceToolBindings(owner)).toHaveLength(120);
  } finally {
    restore();
  }
});
