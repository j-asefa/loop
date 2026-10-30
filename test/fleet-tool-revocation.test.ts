import { afterAll, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { fleetActor } from "./fleet-action-fixture.js";

const root = mkdtempSync(join(tmpdir(), "loop55-fleet-tools-"));
process.env.LOOP55_PROFILE = "companion";
process.env.LOOP55_DATA_DIR = root;
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db } = await import("../src/server/db.js");
const secrets = await import("../src/server/secrets.js");
const { createAgent, ownedRun } = await import("../src/server/domain.js");
const { submit, executeAgent } = await import("../src/server/agent-runtime.js");
const { withTestAdapter } = await import("../src/server/providers.js");
const { invokeNative, nativeBindings } =
  await import("../src/server/native-tools.js");
const { withTestMcp } = await import("../src/server/mcp/client.js");
const { setMcpApprovalMode } =
  await import("../src/server/mcp/approval-policy.js");
const { authorizeFleetEffect } =
  await import("../src/server/fleet-effect-authorizations.js");
const owner = "local-workspace";
const authority = new FleetAuthority(db, secrets);
authority.create(owner, {
  mutationId: randomUUID(),
  name: "Fixture",
  origin: "https://local.example",
  scope: ["read", "act"],
});
const account = randomUUID(),
  connection = randomUUID();
db.prepare(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,0)",
).run(
  account,
  owner,
  secrets.seal("fixture", owner),
  JSON.stringify([{ id: "fixture" }]),
);
db.prepare(
  "INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,tools,metadata,created_at) VALUES(?,?,'Fixture MCP','https://fixture.example/mcp',?,'connected',?,'{}',0)",
).run(
  connection,
  owner,
  secrets.seal(JSON.stringify({ type: "none" }), owner),
  JSON.stringify([
    {
      name: "write_fixture",
      description: "Test-only mutation",
      inputSchema: { type: "object", properties: {} },
    },
  ]),
);
setMcpApprovalMode(owner, "allow");

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

for (const boundary of [
  "model-mcp",
  "model-local-tool",
  "mcp-connect",
] as const)
  it(`refuses a new effect after peer revocation during ${boundary}`, async () => {
    const peer = fleetActor(owner, authority, secrets, authorizeFleetEffect);
    const agent = createAgent(owner, {
      name: "tools-" + boundary,
      connectionId: account,
      model: "fixture",
    });
    const accepted = peer.act(() =>
      submit(owner, {
        agentId: agent.id,
        input: "Isolated tool mutation",
        idempotencyKey: randomUUID(),
      }),
    );
    db.prepare("UPDATE runs SET state='running' WHERE id=?").run(accepted.id);
    const run = ownedRun(accepted.id, owner);
    const entered = gate(),
      resume = gate();
    let effects = 0;
    const restoreMcp = withTestMcp(async () => {
      if (boundary === "mcp-connect") {
        entered.release();
        await resume.promise;
      }
      const server = new McpServer({
        name: "fleet-revocation-fixture",
        version: "1",
      });
      server.registerTool("write_fixture", { inputSchema: {} }, async () => {
        effects++;
        return { content: [{ type: "text", text: "fixture effect" }] };
      });
      const [left, right] = InMemoryTransport.createLinkedPair();
      await server.connect(left);
      const client = new Client({ name: "fixture", version: "1" });
      await client.connect(right);
      return client;
    });
    const restoreProvider = withTestAdapter("openai", {
      async models() {
        return [];
      },
      async *stream(_key, input) {
        if (input.messages.some((message) => message.role === "tool")) {
          yield { text: "Finished fixture" };
          return;
        }
        if (boundary !== "mcp-connect") {
          entered.release();
          await resume.promise;
        }
        const local = boundary === "model-local-tool";
        const binding = input.tools!.find((tool) =>
          local
            ? tool.name === "loop55_diagram"
            : tool.description.includes("write_fixture"),
        )!;
        yield {
          toolCall: {
            id: "fixture-call",
            name: binding.name,
            arguments: local
              ? { title: "Revoked diagram", source: "graph LR; A-->B" }
              : {},
          },
        };
      },
    });
    const executing = executeAgent(run).catch((error: unknown) => error);
    try {
      await Promise.race([
        entered.promise,
        executing.then(() => {
          throw new Error("Run finished before the fault-injection boundary");
        }),
      ]);
      peer.revoke();
      resume.release();
      const outcome = await executing;
      expect(outcome).toMatchObject({ status: 403 });
      expect(effects).toBe(0);
      const local = nativeBindings(run).find(
        (tool) => tool.tool === "loop55_diagram",
      )!;
      await expect(
        invokeNative(run, local, "direct-revoked-call", {
          title: "Revoked diagram",
          source: "graph LR; A-->B",
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM artifacts WHERE run_id=? AND kind='diagram'",
          )
          .get(run.id),
      ).toEqual({ n: 0 });
      if (boundary === "mcp-connect") {
        const invocation = db
          .prepare(
            "SELECT state,result FROM tool_invocations WHERE run_id=? AND call_id='fixture-call'",
          )
          .get(run.id) as { state: string; result: string };
        expect(invocation.state).toBe("unknown");
        expect(JSON.parse(invocation.result).failure.outcome).toBe("not_sent");
      }
    } finally {
      resume.release();
      await executing;
      restoreProvider();
      restoreMcp();
    }
  });
