import { afterAll, afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Response, type fetch as PeerFetch } from "undici";
import { Host } from "../src/host.js";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetCredentials } from "../src/server/fleet-credentials.js";
import { FleetCredentialLeases } from "../src/server/fleet-credential-leases.js";
import { FleetPairing } from "../src/server/fleet-pairing.js";
import { FleetEnrollmentDestination } from "../src/server/fleet-enrollment.js";
import { FleetMailDestination } from "../src/server/fleet-mail-destination.js";
import { FleetMailJournal } from "../src/server/fleet-mail-journal.js";
import { directoryDigest } from "../src/server/fleet-crypto.js";
import {
  fleetAgentAddress,
  type FleetMailEnvelope,
} from "../src/shared/fleet-mail.js";
import {
  fleetMailApi,
  type FleetAgentPage,
} from "../src/shared/fleet-mail-api.js";

const dir = mkdtempSync(join(tmpdir(), "loop55-fleet-mail-discovery-"));
process.env.LOOP55_PROFILE = "companion";
process.env.LOOP55_DATA_DIR = dir;
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { FleetCredentialHttpTransport } =
  await import("../src/server/fleet-credential-http.js");
const { FleetMailHttpTransport } =
  await import("../src/server/fleet-mail-http.js");
const { FleetPeerMail } = await import("../src/server/fleet-peer-mail.js");
const { FleetCapacity } = await import("../src/server/fleet-capacity.js");
const secrets = await import("../src/server/secrets.js");
const { db, id, now } = await import("../src/server/db.js");
const { createAgent } = await import("../src/server/domain.js");
const { submit } = await import("../src/server/agent-runtime.js");
const { claim, transition } = await import("../src/server/queue.js");
const { nativeBindings, invokeNative } =
  await import("../src/server/native-tools.js");
const { FleetMailDiscovery } =
  await import("../src/server/fleet-mail-discovery.js");

const { installFleetMailTools } =
  await import("../src/server/fleet-mail-tools.js");
const { createFleetPeerHttp } =
  await import("../src/server/fleet-peer-http.js");
const owner = "source-owner",
  peerOwner = "different-destination-owner";
const authority = new FleetAuthority(db, secrets);
const peerDb = new Database(":memory:");
applyMigrations(peerDb);
peerDb.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
peerDb.exec(
  "CREATE TABLE fixture_mail_queue(id TEXT PRIMARY KEY,body TEXT NOT NULL)",
);
const peerAuthority = new FleetAuthority(peerDb, secrets);
let origin = "https://destination.example";
const first = authority.create(owner, {
  mutationId: id(),
  name: "Source",
  origin: "https://source.example",
  scope: ["read", "mail"],
});
let directory = authority.revise(owner, {
  mutationId: id(),
  expected: directoryDigest(first.document),
  members: [
    ...first.document.members,
    { ...peerAuthority.identity, grantId: id(), name: "Destination", origin },
  ],
});
peerAuthority.approve(peerOwner, {
  mutationId: id(),
  expected: null,
  kind: "enroll",
  scope: ["read", "mail"],
  controller: authority.identity,
  directory,
  grantId: directory.document.members[1].grantId,
});
const credentials = new FleetCredentials(db, authority, secrets);
const peerCredentials = new FleetCredentials(peerDb, peerAuthority, secrets);
const journal = new FleetMailJournal(db, authority, owner);
const remoteAgents: FleetAgentPage["agents"] = Array.from(
  { length: 3 },
  (_, i) => ({
    agentId: id(),
    name: "remote-" + i,
    runtime: "Codex",
    availability: "available" as const,
  }),
);
let afterDirectory: (() => void) | undefined;
const received: FleetMailEnvelope[] = [];
let deliveryStatus: "queued" | "handled" = "queued";
const service = new FleetMailDestination(
  peerDb,
  peerAuthority,
  peerCredentials,
  peerOwner,
  secrets,
  {
    directory: (query) => {
      const agents = remoteAgents.filter(
        (agent) => !query.query || agent.name.includes(query.query),
      );
      return {
        agents: agents.slice(query.offset, query.offset + query.limit),
        nextOffset:
          query.offset + query.limit < agents.length
            ? query.offset + query.limit
            : null,
      };
    },
    admit: (envelope) => {
      received.push(envelope);
      peerDb
        .prepare("INSERT INTO fixture_mail_queue VALUES(?,?)")
        .run(envelope.messageId, envelope.body);
      return {
        state: "accepted",
        mailId: id(),
        threadId: id(),
        conversationId: id(),
        status: "queued",
      };
    },
    inspect: (admission) =>
      admission.state === "accepted"
        ? { ...admission, status: deliveryStatus }
        : admission,
  },
);
const pairing = new FleetPairing(peerDb, peerAuthority, peerOwner, dir);
const enrollment = new FleetEnrollmentDestination(
  peerDb,
  peerAuthority,
  pairing,
  peerOwner,
  secrets,
  () => origin,
);
const host = new Host(
  dir,
  {
    harness: "codex",
    version: "fixture",
    project: dir,
    billing: {
      mode: "existing",
      description: "Isolated outgoing mail fixture",
    },
    capabilities: {
      approvals: true,
      questions: true,
      resume: true,
      liveAttach: false,
      terminal: false,
    },
  },
  pairing,
);
host.workspace = {
  http: (_request, response) => {
    response.writeHead(404).end();
  },
  peerHttp: createFleetPeerHttp(enrollment, () => origin, {
    credentials: peerCredentials,
    mail: service,
  }),
  status: () => ({}),
  admin: async () => ({}),
  connect: () => () => {},
  originChanged: () => {},
};
await host.listen();
host.setOrigin(origin);
let mode: "normal" | "offline" | "lost" | "before-accept" | "forbidden" =
  "normal";
const calls: string[] = [];
let beforePreparedReply: (() => void) | undefined;
const fetcher: typeof PeerFetch = async (url, options) => {
  const target = new URL(String(url));
  expect(target.origin).toBe(origin);
  calls.push(target.pathname);
  if (mode === "offline") throw new Error("fixture offline");
  if (mode === "forbidden")
    return new Response(
      JSON.stringify({ error: "fixture authentication unavailable" }),
      {
        status: 403,
        headers: { "content-type": "application/json" },
      },
    );
  const input = JSON.parse(String(options?.body));
  if (target.pathname === "/api" + fleetMailApi.accept.path) {
    expect(journal.outgoing(input.envelope.messageId)?.state).toBe("unknown");
    if (mode === "before-accept")
      throw new Error("fixture request lost before destination");
  }
  const reply = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: host.port,
          path: target.pathname,
          method: "POST",
          signal: options?.signal ?? undefined,
          headers: {
            host: target.host,
            "content-type": "application/json",
            "x-loop55-fleet-version": "1",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(input));
    },
  );
  if (target.pathname === "/api" + fleetMailApi.prepare.path)
    beforePreparedReply?.();
  if (target.pathname === "/api" + fleetMailApi.accept.path && mode === "lost")
    throw new Error("fixture lost receipt");
  if (target.pathname === "/api" + fleetMailApi.directory.path)
    afterDirectory?.();
  return new Response(reply.body, {
    status: reply.status,
    headers: { "content-type": "application/json" },
  });
};
const capacity = new FleetCapacity(() => true);
const leases = new FleetCredentialLeases(
  authority,
  credentials,
  owner,
  new FleetCredentialHttpTransport(fetcher, capacity),
);
const transport = new FleetMailHttpTransport(fetcher, capacity);
const peer = new FleetPeerMail(authority, leases, owner, journal, transport);
let discoveryTime = Date.now();
const discovery = new FleetMailDiscovery(
  authority,
  owner,
  peer,
  () => discoveryTime,
);
let disable = installFleetMailTools(owner, discovery);
afterEach(() => {
  afterDirectory = undefined;
  mode = "normal";
  beforePreparedReply = undefined;
  deliveryStatus = "queued";
  calls.length = 0;
  received.length = 0;
  db.exec(
    "DELETE FROM agent_threads; DELETE FROM fleet_mail_outbox; UPDATE runs SET state='completed'",
  );
});
afterAll(async () => {
  disable();
  peer.close();
  leases.close();
  service.close();
  await host.close();
  peerDb.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
function source(harness?: string) {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?,?)",
  ).run(
    connection,
    owner,
    secrets.seal("fixture", owner),
    JSON.stringify([{ id: "fixture" }]),
    JSON.stringify(harness ? { loop55Harness: harness } : {}),
    now(),
  );
  const agent = createAgent(owner, {
    name: "fixture-" + id().slice(0, 20),
    connectionId: connection,
    model: "fixture",
  });
  const queued = submit(owner, {
    agentId: agent.id,
    input: "Send mail",
    idempotencyKey: id(),
  });
  const run = claim("fixture", (candidate) => candidate.id === queued.id)!;
  if (harness) {
    const generation = id();
    db.prepare(
      "INSERT INTO companion_sessions(conversation_id,harness,project,generation,state,updated_at) VALUES(?,?,?,?,'running',?)",
    ).run(run.conversation_id, harness, dir, generation, now());
    db.prepare(
      "INSERT INTO native_dispatch VALUES(?,?,?,'accepted',NULL,?)",
    ).run(run.id, generation, "fixture", now());
  }
  return { agent, run };
}
const sourceId = "peer:" + peerAuthority.identity.machineId;
async function tool(
  run: ReturnType<typeof source>["run"],
  args: Record<string, unknown>,
) {
  const binding = nativeBindings(run).find(
    (binding) => binding.tool === "loop55_agents",
  )!;
  const reply = await invokeNative(run, binding, id(), args);
  if (!("result" in reply)) throw new Error("Unexpected pending discovery");
  return reply.result;
}
function page(result: Awaited<ReturnType<typeof tool>>) {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

it("keeps local pagination independent of offline remote sources", async () => {
  const first = source(),
    second = source();
  mode = "offline";
  const local = page(
    await tool(first.run, { query: second.agent.name, limit: 1 }),
  );
  expect(
    local.agents.map((agent: { agentId: string }) => agent.agentId),
  ).toEqual([second.agent.id]);
  expect(local.sources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sourceId,
        name: "Destination",
        availability: "unknown",
      }),
    ]),
  );
  expect(calls).toEqual([]);
  const failed = page(await tool(first.run, { sourceId }));
  expect(failed.source.availability).toBe("unreachable");
  expect(failed.agents).toEqual([]);
  expect(failed.error).toMatch(/unavailable/);
  calls.length = 0;
  expect(
    page(await tool(first.run, { query: second.agent.name })).agents,
  ).toHaveLength(1);
  expect(calls).toEqual([]);
});

it("uses the signed one-hop directory through the production tool and preserves source pagination", async () => {
  const { run } = source();
  const first = page(await tool(run, { sourceId, limit: 2 }));
  expect(first.nextOffset).toBe(2);
  expect(first.source).toMatchObject({
    sourceId,
    machineId: peerAuthority.identity.machineId,
    availability: "reachable",
  });
  expect(first.agents).toEqual(
    remoteAgents.slice(0, 2).map((agent) => ({
      ...agent,
      localAgentId: agent.agentId,
      agentId: fleetAgentAddress({
        machineId: peerAuthority.identity.machineId,
        agentId: agent.agentId,
      }),
      sourceId,
      executionMachine: "Destination",
    })),
  );
  const second = page(
    await tool(run, { sourceId, offset: first.nextOffset, limit: 2 }),
  );
  expect(second.agents).toHaveLength(1);
  expect(second.nextOffset).toBeNull();
  expect(calls).toContain("/api" + fleetMailApi.directory.path);
  expect(JSON.stringify(first)).not.toMatch(
    /credential|publicKey|grantId|owner_id|secret|https:/,
  );
});

it("does not present an old successful source read as current reachability", async () => {
  const { run } = source();
  page(await tool(run, { sourceId }));
  expect(
    discovery.sources().find((source) => source.sourceId === sourceId)
      ?.availability,
  ).toBe("reachable");
  discoveryTime += 30_001;
  expect(
    discovery.sources().find((source) => source.sourceId === sourceId),
  ).toMatchObject({ availability: "unknown" });
  expect(
    discovery.sources().find((source) => source.sourceId === sourceId)
      ?.checkedAt,
  ).toBeUndefined();
});

it("distinguishes colliding local IDs and display names by owning source", async () => {
  const caller = source(),
    local = source(),
    original = { ...remoteAgents[0] };
  remoteAgents[0] = {
    ...remoteAgents[0],
    agentId: local.agent.id,
    name: local.agent.name,
  };
  try {
    const nearby = page(await tool(caller.run, { query: local.agent.name }));
    const remote = page(
      await tool(caller.run, { sourceId, query: local.agent.name }),
    );
    expect(nearby.agents[0].agentId).toBe(local.agent.id);
    expect(remote.agents[0].agentId).toBe(
      fleetAgentAddress({
        machineId: peerAuthority.identity.machineId,
        agentId: local.agent.id,
      }),
    );
    expect(remote.agents[0].executionMachine).toBe("Destination");
  } finally {
    remoteAgents[0] = original;
  }
});

it("rejects an unknown or another owner's source before network activity", async () => {
  const { run } = source();
  const unavailable = new FleetMailDiscovery(authority, "other-owner", peer);
  expect(() => unavailable.sources()).toThrow("This owner has no fleet grant.");
  await expect(
    unavailable.read(sourceId, { offset: 0, limit: 20 }, () => {}),
  ).rejects.toThrow("This owner has no fleet grant.");
  const result = await tool(run, { sourceId: "peer:m_" + "0".repeat(64) });
  expect(result.isError).toBe(true);
  expect(calls).toEqual([]);
});

it("fails closed without the optional discovery service and does not alter local callers", async () => {
  const { run } = source();
  disable();
  expect((await tool(run, { sourceId })).isError).toBe(true);
  expect(page(await tool(run, {})).sources).toBeUndefined();
  expect(calls).toEqual([]);
  disable = installFleetMailTools(owner, discovery);
});

it.each(["claude", "codex", "pi", "opencode", "gemini", "muse", "grok", "acp"])(
  "rejects a late %s directory response after its executing generation changes",
  async (harness) => {
    const { run } = source(harness);
    afterDirectory = () =>
      db
        .prepare(
          "UPDATE companion_sessions SET generation=? WHERE conversation_id=?",
        )
        .run(id(), run.conversation_id);
    const result = await tool(run, { sourceId });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/original native task/);
    expect(result.content[0].text).not.toContain(remoteAgents[0].name);
  },
);

it("rejects a late directory response after cancellation", async () => {
  const { run } = source();
  afterDirectory = () => transition(run, "cancelled");
  await expect(tool(run, { sourceId })).rejects.toThrow(/no longer executing/);
});

it("rechecks known removals before publishing a directory response", async () => {
  const { run } = source();
  afterDirectory = () => {
    directory = authority.revise(owner, {
      mutationId: id(),
      expected: directoryDigest(directory.document),
      members: directory.document.members.filter(
        (member) => member.machineId !== peerAuthority.identity.machineId,
      ),
    });
  };
  expect((await tool(run, { sourceId })).isError).toBe(true);
  expect(discovery.sources()).toHaveLength(1);
});
