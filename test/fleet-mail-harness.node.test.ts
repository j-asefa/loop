import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { until } from "./helpers.js";
import { gitProject } from "./git-project.js";

const root = mkdtempSync(join(tmpdir(), "loop55-mail-harness-"));
const project = join(root, "project");
mkdirSync(project);
gitProject(project);
process.env.LOOP55_PROFILE = "companion";
process.env.LOOP55_DATA_DIR = join(root, "data");
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.LOOP55_TEST_FLEET_DISCOVERY_HELPER = resolve(
  "test/fixtures/fleet-discovery-client.mjs",
);
process.env.LOOP55_TEST_FLEET_ACCEPTANCE_HELPER = resolve(
  "test/fixtures/fleet-acceptance-client.mjs",
);
process.env.LOOP55_TEST_MUSE_DIR = root;
process.env.LOOP55_TEST_FLEET_MAIL_SEND = "1";
writeFileSync(
  join(root, "muse-credential.json"),
  JSON.stringify({ state: "accountLogin" }),
);
const { db } = await import("../src/server/db.js");
const { createAgent } = await import("../src/server/domain.js");
const { submit } = await import("../src/server/agent-runtime.js");
const { ExecutionProcess } = await import("../src/server/execution-process.js");
const { executionRequest } = await import("../src/server/execution-client.js");
const { OWNER, nativeSessions } =
  await import("../src/server/native-sessions.js");
const { fleetMailWorkerService } =
  await import("../src/server/fleet-mail-worker-service.js");
const { fleetAgentAddress } = await import("../src/shared/fleet-mail.js");
const { FleetAuthority } = await import("../src/server/fleet-authority.js");
const { applyMigrations } = await import("../src/server/migrations.js");
const { directoryDigest } = await import("../src/server/fleet-crypto.js");
const secrets = await import("../src/server/secrets.js");
const peerDb = new Database(":memory:");
applyMigrations(peerDb);
peerDb.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
const authority = new FleetAuthority(db, secrets);
const peer = new FleetAuthority(peerDb, secrets);
const first = authority.create(OWNER, {
  mutationId: randomUUID(),
  name: "Source",
  origin: "https://source.example",
  scope: ["mail", "files"],
});
authority.revise(OWNER, {
  mutationId: randomUUID(),
  expected: directoryDigest(first.document),
  members: [
    ...first.document.members,
    {
      ...peer.identity,
      name: "Peer",
      origin: "https://peer.example",
      grantId: randomUUID(),
    },
  ],
});
after(async () => {
  await nativeSessions.close();
  db.close();
  peerDb.close();
  rmSync(root, { recursive: true, force: true });
});

for (const harness of [
  "claude",
  "codex",
  "pi",
  "opencode",
  "gemini",
  "muse",
  "grok",
  "acp",
] as const) {
  test(
    `${harness} discovers peers and persists remote mail, handoff and status through its production native bridge`,
    { timeout: 60_000 },
    async (t) => {
      process.env.LOOP55_TEST_HARNESS = harness;
      const auditPath = join(root, `${harness}-discovery.jsonl`);
      process.env.LOOP55_TEST_FLEET_DISCOVERY_AUDIT = auditPath;
      const acceptanceAudit = join(root, `${harness}-acceptance.jsonl`);
      process.env.LOOP55_TEST_FLEET_ACCEPTANCE_AUDIT = acceptanceAudit;
      const execution = new ExecutionProcess();
      t.after(() => execution.close());
      const machineId = peer.identity.machineId,
        sourceId = "peer:" + machineId,
        remoteAgent = randomUUID();
      const source = {
        machineId,
        sourceId,
        name: "Fixture peer",
        availability: "reachable" as const,
      };
      let reads = 0;
      execution.setFleetMail(
        fleetMailWorkerService(OWNER, {
          sources: () => [source],
          async read(id, query, current) {
            current();
            assert.equal(id, sourceId);
            assert.equal(query.offset, 0);
            reads++;
            return {
              source,
              agents: [
                {
                  agentId: fleetAgentAddress({
                    machineId,
                    agentId: remoteAgent,
                  }),
                  localAgentId: remoteAgent,
                  sourceId,
                  executionMachine: source.name,
                  name: "remote-fixture",
                  runtime: "Codex",
                  availability: "available",
                },
              ],
              nextOffset: null,
            };
          },
        }),
      );
      await execution.open();
      const generation = execution.status().generation;
      await executionRequest("runtime.register", {
        options: {
          harness,
          ...(harness === "acp"
            ? {
                executable: process.execPath,
                args: [resolve("test/fixtures/fake-acp.mjs")],
              }
            : {
                executable: resolve(
                  ["gemini", "muse", "grok"].includes(harness)
                    ? `test/fixtures/fake-${harness}.mjs`
                    : "test/harness.mjs",
                ),
              }),
          project,
          billing: "existing",
          version: "fixture",
        },
      });
      const connection = db
        .prepare(
          "SELECT id FROM connections WHERE owner_id=? AND json_extract(metadata,'$.loop55Harness')=?",
        )
        .get(OWNER, harness) as { id: string };
      assert(connection);
      const neighbor = createAgent(OWNER, {
        name: `${harness}-local-neighbor`,
        connectionId: connection.id,
        model: "native-default",
      });
      const agent = createAgent(OWNER, {
        name: `${harness}-local-fixture`,
        connectionId: connection.id,
        model: "native-default",
      });
      await execution.schedule();
      const run = submit(OWNER, {
        agentId: agent.id,
        input: "Fleet discovery fixture: " + sourceId,
        idempotencyKey: randomUUID(),
      });
      await until(() => {
        const row = db
          .prepare("SELECT state FROM runs WHERE id=?")
          .get(run.id) as { state: string };
        return ["completed", "failed"].includes(row.state);
      }, 30_000);
      const finished = db
        .prepare("SELECT state,error FROM runs WHERE id=?")
        .get(run.id) as { state: string; error: string | null };
      const audit = existsSync(auditPath)
        ? readFileSync(auditPath, "utf8")
        : "";
      assert.equal(finished.state, "completed", finished.error ?? audit);
      assert.equal(reads, 1, audit);
      assert.equal(execution.status().generation, generation);
      const rows = audit
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(rows.length, 1);
      const result = rows[0];
      assert.equal(result.ok, true);
      assert.match(
        JSON.stringify(result.local),
        new RegExp(`${harness}-local-neighbor`),
      );
      assert.equal(result.local.sourceId, "");
      assert(
        result.local.agents.some(
          (entry: { agentId: string }) => entry.agentId === neighbor.id,
        ),
      );
      assert(
        !result.local.agents.some(
          (entry: { agentId: string }) => entry.agentId === agent.id,
        ),
      );
      assert(
        result.local.agents.every(
          (entry: { agentId: string }) => !entry.agentId.startsWith("peer:"),
        ),
      );
      assert(
        JSON.stringify(result.remote).includes(
          fleetAgentAddress({ machineId, agentId: remoteAgent }),
        ),
      );
      assert.match(JSON.stringify(result.remote), /remote-fixture/);
      assert(
        !/credential|publicKey|privateKey|https:|http:|owner_id/.test(audit),
      );
      const native = db
        .prepare("SELECT generation,state FROM native_dispatch WHERE run_id=?")
        .get(run.id) as { generation: string; state: string };
      assert(native.generation);
      assert.equal(native.state, "completed");
      assert.equal(result.mail.sent.delivery, "transport_pending");
      assert.equal(result.mail.handoff.delivery, "transport_pending");
      assert.equal(result.mail.sent.threadId, result.mail.handoff.threadId);
      const intents = db
        .prepare(
          `
        SELECT o.envelope,o.state,o.transmitted_at,m.id,m.state AS mail_state,d.native_generation
        FROM agent_mail m LEFT JOIN fleet_mail_outbox o ON m.id=o.message_id AND m.owner_id=o.owner_id
        JOIN fleet_mail_dispatch d ON d.mail_id=m.id
        WHERE m.owner_id=? AND m.sender_run_id=? ORDER BY m.rowid
      `,
        )
        .all(OWNER, run.id) as {
        envelope: string | null;
        state: string | null;
        mail_state: string;
        transmitted_at: number | null;
        id: string;
        native_generation: string;
      }[];
      assert.equal(intents.length, 2);
      assert.deepEqual(
        intents.map((row) => row.id),
        [result.mail.sent.messageId, result.mail.handoff.messageId],
      );
      for (const row of intents) {
        assert.equal(row.mail_state, "pending");
        assert.equal(row.transmitted_at, null);
        assert.equal(row.native_generation, native.generation);
      }
      // Ordered delivery materializes only the thread's first wire envelope.
      // Both accepted mail intents already retain the original native authority;
      // the handoff cannot bypass the pending message ahead of it.
      assert.equal(intents[0].state, "pending");
      assert.equal(intents[1].state, null);
      assert.equal(intents[1].envelope, null);
      for (const row of intents.filter(
        (entry): entry is typeof entry & { envelope: string } =>
          entry.envelope !== null,
      )) {
        const envelope = JSON.parse(row.envelope);
        assert.deepEqual(envelope.destination, {
          machineId,
          agentId: remoteAgent,
        });
        assert.deepEqual(envelope.source, {
          machineId: authority.identity.machineId,
          agentId: agent.id,
        });
        assert.equal(envelope.sender.runId, run.id);
        assert(!row.envelope.includes(native.generation));
      }
      assert.equal(
        db.prepare("SELECT 1 FROM agents WHERE id=?").get(remoteAgent),
        undefined,
      );
      if (harness === "codex") {
        // Validate the live runner's native helper before any Internet run. It
        // publishes actual bytes and persists an outgoing envelope through the
        // production bridge; this fixture does not deliver to a remote host.
        const task = {
          caseId: "native-acceptance-helper",
          kind: "send",
          to: fleetAgentAddress({ machineId, agentId: remoteAgent }),
          replyTo: fleetAgentAddress({
            machineId: authority.identity.machineId,
            agentId: agent.id,
          }),
          content: "Acceptance attachment bytes\n",
        };
        const acceptanceRun = submit(OWNER, {
          agentId: agent.id,
          input:
            "FLEET_ACCEPTANCE:" +
            Buffer.from(JSON.stringify(task)).toString("base64url"),
          idempotencyKey: randomUUID(),
        });
        await until(() => {
          const row = db
            .prepare("SELECT state FROM runs WHERE id=?")
            .get(acceptanceRun.id) as { state: string };
          return ["completed", "failed"].includes(row.state);
        }, 30_000);
        const receipt = JSON.parse(readFileSync(acceptanceAudit, "utf8"));
        assert.equal(receipt.ok, true);
        assert.equal(receipt.kind, "send");
        const outgoing = db
          .prepare(
            "SELECT envelope,state,transmitted_at FROM fleet_mail_outbox WHERE message_id=? AND owner_id=?",
          )
          .get(receipt.messageId, OWNER) as {
          envelope: string;
          state: string;
          transmitted_at: number | null;
        };
        assert.equal(outgoing.state, "pending");
        assert.equal(outgoing.transmitted_at, null);
        const envelope = JSON.parse(outgoing.envelope);
        assert.equal(envelope.files.length, 1);
        assert.equal(envelope.files[0].bytes, Buffer.byteLength(task.content));
        assert.equal(envelope.files[0].source, authority.identity.machineId);
        assert.equal(envelope.sender.runId, acceptanceRun.id);
        assert(
          !/credential|publicKey|privateKey|https:|http:/.test(
            JSON.stringify(receipt),
          ),
        );
      }
    },
  );
}
