import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";

const dir = mkdtempSync(join(tmpdir(), "loop55-mcp-import-"));
process.env.LOOP55_DATA_DIR = dir;
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
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
const { authorizeConnectionTool } = await import("../src/server/mcp/broker");
const {
  enrollFederationPeer,
  localFederationCatalog,
  invokeLocalFederatedTool,
} = await import("../src/server/mcp/federation");

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
it("keeps a tool's published name when another connection is added or disabled", () => {
  const owner = id();
  const first = insert(owner, [smallTool("lookup")]);
  const before = workspaceToolBindings(owner).find(
    (binding) => binding.connectionId === first,
  );
  expect(before?.name).toMatch(/^loop55_tool_[0-9a-f]{24}$/);
  const second = insert(owner, [smallTool("lookup")]);
  expect(
    workspaceToolBindings(owner).find(
      (binding) => binding.connectionId === first,
    )?.name,
  ).toBe(before?.name);
  expect(
    workspaceToolBindings(owner).find(
      (binding) => binding.connectionId === second,
    )?.name,
  ).not.toBe(before?.name);
  db.prepare("UPDATE mcp_connections SET status='disabled' WHERE id=?").run(
    second,
  );
  expect(workspaceToolBindings(owner)[0].name).toBe(before?.name);
});
it("shares only source-owned tools and never replays a known or uncertain peer call", async () => {
  const owner = id();
  const other = id();
  insert(other, [smallTool("private")]);
  insert(owner, [smallTool("lookup")]);
  const peerId = `docker:${id()}`;
  enrollFederationPeer(owner, peerId);
  const catalog = localFederationCatalog(owner);
  expect(catalog).toHaveLength(1);
  expect(catalog[0].name).toMatch(/^shared_[0-9a-f]{24}$/);
  let calls = 0;
  const restore = withTestMcp(
    async () =>
      ({
        callTool: async () => {
          calls++;
          return { content: [{ type: "text", text: "done" }] };
        },
        close: async () => {},
      }) as any,
  );
  try {
    const run = id();
    const request = "first-call";
    const args = {};
    const first = await invokeLocalFederatedTool(
      owner,
      peerId,
      run,
      request,
      catalog[0].name,
      args,
    );
    expect(first).toEqual({ content: [{ type: "text", text: "done" }] });
    expect(
      await invokeLocalFederatedTool(
        owner,
        peerId,
        run,
        request,
        catalog[0].name,
        args,
      ),
    ).toEqual(first);
    expect(calls).toBe(1);
    await expect(
      invokeLocalFederatedTool(owner, peerId, run, request, catalog[0].name, {
        changed: true,
      }),
    ).rejects.toThrow();
    await expect(
      invokeLocalFederatedTool(
        other,
        peerId,
        run,
        "foreign",
        catalog[0].name,
        args,
      ),
    ).rejects.toThrow("not shared");
    expect(calls).toBe(1);
  } finally {
    restore();
  }
  let uncertainCalls = 0;
  const fail = withTestMcp(
    async () =>
      ({
        callTool: async () => {
          uncertainCalls++;
          throw new Error("connection lost after send");
        },
        close: async () => {},
      }) as any,
  );
  try {
    const run = id();
    await expect(
      invokeLocalFederatedTool(
        owner,
        peerId,
        run,
        "uncertain",
        catalog[0].name,
        {},
      ),
    ).rejects.toThrow("uncertain");
    await expect(
      invokeLocalFederatedTool(
        owner,
        peerId,
        run,
        "uncertain",
        catalog[0].name,
        {},
      ),
    ).rejects.toThrow("uncertain");
    expect(uncertainCalls).toBe(1);
  } finally {
    fail();
  }
});
it("shares GitHub merges under the approval policy while retaining the head requirement", async () => {
  const sourceOwner = id(),
    owner = id();
  const source = insert(sourceOwner, [smallTool("merge_pull_request")]);
  db.prepare(
    "UPDATE mcp_connections SET url='https://api.githubcopilot.com/mcp/' WHERE id=?",
  ).run(source);
  const catalog = localFederationCatalog(sourceOwner);
  expect(catalog).toHaveLength(1);
  expect(catalog[0]._meta.loop55).toEqual({
    github: true,
    sourceTool: "merge_pull_request",
    alwaysAsk: false,
  });
  const connection = insert(owner, catalog);
  db.prepare("UPDATE mcp_connections SET metadata=? WHERE id=?").run(
    JSON.stringify({
      transport: "federation",
      federatedPeer: "docker:" + "d".repeat(64),
    }),
    connection,
  );
  expect(() =>
    authorizeConnectionTool(owner, connection, catalog[0].name, {}),
  ).toThrow(/expectedHeadSha/);
  const args = {
    owner: "acme",
    repo: "api",
    pullNumber: 42,
    expectedHeadSha: "a".repeat(40),
  };
  expect(() =>
    authorizeConnectionTool(owner, connection, catalog[0].name, args),
  ).not.toThrow();
  const run = enqueue(owner, "Merge the reviewed PR", id());
  const approval = requestApproval(run, {
    type: "mcp_tool",
    connectionId: connection,
    tool: catalog[0].name,
    arguments: args,
  });
  db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(
    run.id,
  );
  const changed = await api(
    owner,
    "/mcp/preferences",
    { approvalMode: "allow" },
    "PUT",
  );
  expect(changed.data.resumed).toBe(1);
  expect(
    db.prepare("SELECT state FROM approvals WHERE id=?").get(approval.id),
  ).toEqual({ state: "approved" });
  expect(
    db
      .prepare("SELECT 1 FROM personal_decisions WHERE approval_id=?")
      .get(approval.id),
  ).toBeUndefined();
});

it("honors an older shared source's explicit alwaysAsk restriction even in Allow", async () => {
  const owner = id();
  const tool = "shared_" + "b".repeat(24);
  const connection = insert(owner, [
    {
      ...smallTool(tool),
      _meta: {
        loop: {
          github: true,
          alwaysAsk: true,
          sourceTool: "merge_pull_request",
        },
      },
    },
  ]);
  // Shared tools arrive over a federation connection, the only kind whose
  // `_meta.loop55` hints are trusted.
  db.prepare("UPDATE mcp_connections SET metadata=? WHERE id=?").run(
    JSON.stringify({
      transport: "federation",
      federatedPeer: "docker:" + "c".repeat(64),
    }),
    connection,
  );
  expect(() => authorizeConnectionTool(owner, connection, tool, {})).toThrow();
  const run = enqueue(owner, "Shared merge", id());
  const approval = requestApproval(run, {
    type: "mcp_tool",
    connectionId: connection,
    tool,
  });
  db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(
    run.id,
  );
  const changed = await api(
    owner,
    "/mcp/preferences",
    { approvalMode: "allow" },
    "PUT",
  );
  expect(changed.data.resumed).toBe(0);
  expect(
    (
      db
        .prepare("SELECT state FROM approvals WHERE id=?")
        .get(approval.id) as any
    ).state,
  ).toBe("pending");
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("persists owner-scoped approval preferences and resumes only current MCP calls on connected servers", async () => {
  const owner = id(),
    other = id();
  const connection = insert(owner, [smallTool("fixture")]),
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
  ).toEqual({
    approvalMode: "allow",
    resumed: 1,
    agentPermissionMode: "default",
  });
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
  // Native harness tool calls have their own owner-scoped preference.
  expect(
    (
      await api(
        owner,
        "/mcp/preferences",
        { agentPermissionMode: "bypassPermissions" },
        "PUT",
      )
    ).data,
  ).toEqual({
    approvalMode: "ask",
    resumed: 0,
    agentPermissionMode: "bypassPermissions",
  });
  expect((await api(owner, "/mcp/preferences")).data).toEqual({
    approvalMode: "ask",
    agentPermissionMode: "bypassPermissions",
  });
  expect((await api(other, "/mcp/preferences")).data.agentPermissionMode).toBe(
    "default",
  );
  expect(
    (
      await api(
        owner,
        "/mcp/preferences",
        { agentPermissionMode: "yolo" },
        "PUT",
      )
    ).status,
  ).toBeGreaterThanOrEqual(400);
  expect((await api(owner, "/mcp/preferences")).data.agentPermissionMode).toBe(
    "bypassPermissions",
  );
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
    Array.from({ length: MCP_TOOL_BUDGET.count }, (_, i) =>
      smallTool("other_" + i),
    ),
  );
  const original = insert(
    owner,
    Array.from({ length: MCP_TOOL_BUDGET.count - 1 }, (_, i) =>
      smallTool("tool_" + i),
    ),
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
    expect(workspaceToolBindings(owner)).toHaveLength(
      MCP_TOOL_BUDGET.count - 1,
    );
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
  const large = Array.from(
    { length: Math.floor(MCP_TOOL_BUDGET.bytes / 40_000) },
    (_, i) => ({
      name: "large_" + i,
      inputSchema: {
        type: "object",
        description: "界".repeat(9000),
      },
    }),
  );
  insert(owner, large);
  const candidate = insert(owner, [], "disabled");
  const restore = fixture(large);
  try {
    await expect(discover(record(candidate))).rejects.toBeInstanceOf(
      ToolBudgetError,
    );
    expect(record(candidate).status).toBe("disabled");
    expect(workspaceToolBindings(owner)).toHaveLength(large.length);
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
    Array.from({ length: MCP_TOOL_BUDGET.count - 1 }, (_, i) =>
      smallTool("old_" + i),
    ),
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
    expect(workspaceToolBindings(owner)).toHaveLength(MCP_TOOL_BUDGET.count);
  } finally {
    restore();
  }
});

it("keeps a refreshed shared catalog connected when Docker's tools would exceed the budget", async () => {
  const owner = id();
  insert(
    owner,
    Array.from({ length: MCP_TOOL_BUDGET.count - 1 }, (_, i) =>
      smallTool("local_" + i),
    ),
  );
  const shared = insert(owner, [smallTool("shared_one")]);
  const restore = fixture(
    Array.from({ length: 10 }, (_, i) => smallTool("shared_" + i)),
  );
  try {
    await expect(
      discover(record(shared), { keepOnBudget: true }),
    ).rejects.toBeInstanceOf(ToolBudgetError);
    expect(record(shared).status).toBe("connected");
    expect(JSON.parse(record(shared).tools)).toHaveLength(1);
    // A first-time or explicit discovery still disables an oversized catalog.
    await expect(discover(record(shared))).rejects.toBeInstanceOf(
      ToolBudgetError,
    );
    expect(record(shared).status).toBe("disabled");
  } finally {
    restore();
  }
});

it("trusts tool renaming and GitHub hints only from federation connections", async () => {
  const { loop55Hints } = await import("../src/server/mcp/broker");
  const tool = {
    name: "delete_repo",
    _meta: {
      loop: { sourceTool: "list_files", github: true, alwaysAsk: true },
    },
  };
  expect(loop55Hints({ metadata: "{}" }, tool)).toEqual({
    sourceTool: undefined,
    github: false,
    alwaysAsk: true,
  });
  expect(
    loop55Hints(
      { metadata: JSON.stringify({ transport: "federation" }) },
      tool,
    ),
  ).toEqual({ sourceTool: "list_files", github: true, alwaysAsk: true });
});

it("keeps a shared call retryable when its connection fails before anything is sent", async () => {
  const owner = id();
  insert(owner, [smallTool("lookup")]);
  const peerId = `docker:${id()}`;
  enrollFederationPeer(owner, peerId);
  const name = localFederationCatalog(owner)[0].name;
  const run = id();
  let restore = withTestMcp(async () => {
    throw new Error("connection refused");
  });
  try {
    await expect(
      invokeLocalFederatedTool(owner, peerId, run, "call", name, {}),
    ).rejects.toThrow("connection refused");
  } finally {
    restore();
  }
  expect(
    db
      .prepare("SELECT count(*) n FROM mcp_federation_calls WHERE peer_id=?")
      .get(peerId),
  ).toEqual({ n: 0 });
  restore = withTestMcp(
    async () =>
      ({
        callTool: async () => ({
          content: [{ type: "text", text: "sent once" }],
        }),
        close: async () => {},
      }) as any,
  );
  try {
    expect(
      await invokeLocalFederatedTool(owner, peerId, run, "call", name, {}),
    ).toMatchObject({ content: [{ text: "sent once" }] });
  } finally {
    restore();
  }
});
