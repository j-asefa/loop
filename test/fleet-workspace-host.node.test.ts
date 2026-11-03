import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  request,
  type ClientRequest,
  type IncomingHttpHeaders,
} from "node:http";
import Database from "better-sqlite3";
import { WebSocket } from "ws";
import { once, EventEmitter } from "node:events";
import { Response as PeerResponse, type fetch as PeerFetch } from "undici";
import {
  FLEET_EVENTS_PATH,
  SignedFleetEventResponse,
} from "../src/shared/fleet-workspace-events.js";
import { WORKSPACE_MULTIPLEX_PATH } from "../src/shared/workspace-multiplex.js";

// WorkspaceHost loads the real application: set its isolated profile first.
const root = mkdtempSync(join(tmpdir(), "loop55-fleet-workspace-host-"));
process.env.LOOP55_PROFILE = "companion";
process.env.LOOP55_DATA_DIR = root;
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { WorkspaceHost } = await import("../src/workspace-host.js");
const { FleetAuthority } = await import("../src/server/fleet-authority.js");
const { FleetCredentials } = await import("../src/server/fleet-credentials.js");
const { applyMigrations } = await import("../src/server/migrations.js");
const { directoryDigest, fleetPayloadDigest } =
  await import("../src/server/fleet-crypto.js");
const { fleetDeviceFromLink } = await import("../src/shared/fleet-pairing.js");
const { fleetWorkspaceApi } =
  await import("../src/shared/fleet-workspace-api.js");
const { fleetWorkspaceActionApi } =
  await import("../src/shared/fleet-workspace-action-api.js");
const { fleetWorkspaceFileApi } =
  await import("../src/shared/fleet-workspace-file-api.js");
const { fleetWorkspaceUploadApi } =
  await import("../src/shared/fleet-workspace-upload-api.js");
const { fleetCredentialApi } =
  await import("../src/shared/fleet-credential-api.js");
const { fleetGatewayApi } = await import("../src/shared/fleet-gateway-api.js");
const { fleetMailApi } = await import("../src/shared/fleet-mail-api.js");
const { createCardToken } = await import("../src/server/card-tokens.js");
const { db, changes } = await import("../src/server/db.js");
const { FleetProof, verifyFleetProof } =
  await import("../src/server/fleet-proof.js");
const { FleetWorkspaceEventHttpTransport } =
  await import("../src/server/fleet-workspace-event-http.js");
const { FleetCapacity } = await import("../src/server/fleet-capacity.js");
const { FleetCredentialLeases } =
  await import("../src/server/fleet-credential-leases.js");
const { FleetCredentialHttpTransport } =
  await import("../src/server/fleet-credential-http.js");
const { FleetWorkspaceHttpTransport } =
  await import("../src/server/fleet-workspace-http.js");
const { FleetPeerReads } = await import("../src/server/fleet-peer-reads.js");
const { FleetPeerEvents } = await import("../src/server/fleet-peer-events.js");
const { OWNER, nativeSessions } =
  await import("../src/server/native-sessions.js");
const { closeExecution } = await import("../src/server/execution-client.js");
const secrets = await import("../src/server/secrets.js");
const origin = "https://workspace.example";
const host = new WorkspaceHost(
  root,
  {
    harness: "codex",
    executable: process.execPath,
    project: root,
    version: "fixture",
    billing: "existing",
    fleet: true,
  },
  { open: async () => {}, schedule: async () => {}, close: async () => {} },
);
const sourceDb = new Database(":memory:");
applyMigrations(sourceDb);
sourceDb.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
const source = new FleetAuthority(sourceDb, secrets),
  sourceOwner = randomUUID();
const sourceCredentials = new FleetCredentials(sourceDb, source, secrets);
const scope = ["read", "act", "files", "events", "mail"] as const;
const first = source.create(sourceOwner, {
  mutationId: randomUUID(),
  name: "Peer",
  origin: "https://peer.example",
  scope: [...scope],
});
const directory = source.revise(sourceOwner, {
  mutationId: randomUUID(),
  expected: directoryDigest(first.document),
  members: [
    ...first.document.members,
    {
      ...host.fleet!.identity,
      origin,
      name: "Destination",
      grantId: randomUUID(),
    },
  ],
});
const head = directoryDigest(directory.document);
let cookie = "",
  csrf = "";
function http(
  path: string,
  input?: unknown,
  headers: Record<string, string> = {},
) {
  return new Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: any;
  }>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: host.gateway.port,
        path,
        method: input === undefined ? "GET" : "POST",
        headers: {
          host: new URL(origin).host,
          "content-type": "application/json",
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(input === undefined ? undefined : JSON.stringify(input));
  });
}
const protocol = (
  path: string,
  input: unknown,
  headers: Record<string, string> = {},
) => http("/api" + path, input, { "x-loop55-fleet-version": "1", ...headers });
async function token(operation: (typeof scope)[number]) {
  const context = {
    fleetId: directory.document.fleetId,
    grantId: directory.document.members[1].grantId,
    destination: host.fleet!.identity.machineId,
    peer: source.identity.machineId,
    directory: head,
    operation,
  };
  const challenge = await protocol(
    fleetCredentialApi.credentialChallenge.path,
    context,
  );
  assert.equal(challenge.status, 200);
  const proof = sourceCredentials.prove(sourceOwner, challenge.body);
  const issued = await protocol(fleetCredentialApi.credentialIssue.path, proof);
  assert.equal(issued.status, 200);
  return sourceCredentials.accept(sourceOwner, proof, issued.body).token;
}
async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Fixture event did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("WorkspaceHost mounts owner-bound sources, reads, actions, files and device receipts", async (t) => {
  try {
    assert(host.fleetWorkspace);
    assert(host.fleetMail);
    assert(host.gateway.workspace?.sources);
    await host.gateway.listen();
    host.setOrigin(origin);
    const pair = fleetDeviceFromLink(host.gateway.pair().url, origin);
    const paired = await http(
      "/pair",
      { secret: pair.secret, name: "Fixture", ceremonyId: pair.ceremonyId },
      { origin },
    );
    assert.equal(paired.status, 200);
    cookie = paired.headers["set-cookie"]![0].split(";")[0];
    csrf = (await http("/session", undefined, { origin, cookie })).body.csrf;
    // No peers become visible before local enrollment consent.
    assert.deepEqual(await host.fleetWorkspace.source.discover(), []);
    host.fleet!.approve(OWNER, {
      mutationId: randomUUID(),
      expected: null,
      kind: "enroll",
      scope: [...scope],
      controller: source.identity,
      directory,
      grantId: directory.document.members[1].grantId,
    });
    assert.deepEqual(await host.fleetWorkspace.source.discover(), [
      { id: source.identity.machineId, name: "Peer" },
    ]);
    const read = await token("read"),
      act = await token("act"),
      files = await token("files");
    const foreignAgent = randomUUID(),
      foreignOwner = randomUUID();
    db.prepare(
      "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,instructions,origin,created_at) VALUES(?,?,'Foreign','foreign','openai','fixture','untouched','loop55',0)",
    ).run(foreignAgent, foreignOwner);
    await t.test(
      "incomplete public capabilities requests cannot occupy authenticated capacity",
      async () => {
        const pending: ClientRequest[] = [];
        let refused = 0;
        try {
          for (let i = 0; i < 161; i++) {
            const req = request(
              {
                hostname: "127.0.0.1",
                port: host.gateway.port,
                path: "/api/capabilities",
                method: "GET",
                headers: {
                  host: new URL(origin).host,
                  "content-type": "application/json",
                  "content-length": "10000",
                },
              },
              (res) => {
                if (res.statusCode === 503) refused++;
                res.resume();
              },
            );
            pending.push(req);
            req.on("error", () => {});
            req.write("{");
          }
          await waitFor(() => refused > 0);
          assert.equal(host.fleetCapacity!.snapshot().browser, 0);
          assert.equal(
            (await http("/api/bootstrap", undefined, { origin, cookie }))
              .status,
            200,
          );
          assert.equal(
            (
              await protocol(fleetWorkspaceApi.catalog.path, {
                version: 1,
                requestId: randomUUID(),
                credential: read,
              })
            ).status,
            200,
          );
        } finally {
          for (const req of pending) req.destroy();
          await waitFor(() => host.fleetCapacity!.snapshot().total === 0);
        }
      },
    );
    await t.test(
      "rejected token and peer upgrades leave authenticated reconnect capacity available",
      async () => {
        const sockets: WebSocket[] = [];
        const open = (path: string, headers: Record<string, string>) => {
          const ws = new WebSocket(
            `ws://127.0.0.1:${host.gateway.port}${path}`,
            {
              headers: { host: new URL(origin).host, ...headers },
            },
          );
          sockets.push(ws);
          ws.on("error", () => {});
          return ws;
        };
        try {
          const rejected = await Promise.all(
            Array.from({ length: 80 }, async (_, i) => {
              const ws = open(
                i % 2 ? FLEET_EVENTS_PATH : "/api/events/stream",
                {
                  authorization: "Bearer invalid",
                  ...(i % 2 ? { "x-loop55-fleet-version": "1" } : {}),
                },
              );
              const [, response] = await once(ws, "unexpected-response");
              response.resume();
              ws.terminate();
              return response.statusCode;
            }),
          );
          assert(
            rejected.every((status) => status === 401 || status === 403),
            "Authentication rejection must precede shared setup admission",
          );
          await waitFor(() => host.fleetCapacity!.snapshot().total === 0);
          const bearer = createCardToken(OWNER, {
            request_id: randomUUID(),
            name: "Reconnect fixture",
            secret: "loop_token_" + randomBytes(32).toString("base64url"),
            scopes: ["read"],
          });
          const credential = await token("events");
          for (const [path, headers] of [
            [
              "/api/events/stream",
              { authorization: "Bearer " + bearer.secret },
            ],
            [WORKSPACE_MULTIPLEX_PATH, { origin, cookie }],
            [
              FLEET_EVENTS_PATH,
              {
                authorization: "Bearer " + credential,
                "x-loop55-fleet-version": "1",
              },
            ],
          ] as [string, Record<string, string>][]) {
            const ws = open(path, headers);
            await once(ws, "open");
          }
          assert.equal(host.fleetCapacity!.snapshot().browser, 2);
          assert.equal(host.fleetCapacity!.snapshot().peer, 1);
        } finally {
          for (const ws of sockets) ws.terminate();
          await waitFor(() => host.fleetCapacity!.snapshot().total === 0);
        }
      },
    );
    await t.test(
      "workspace integration tokens cannot become peer or device credentials",
      async () => {
        const bearer = createCardToken(OWNER, {
          request_id: randomUUID(),
          name: "Local read fixture",
          secret: "loop55_token_" + randomBytes(32).toString("base64url"),
          scopes: ["read"],
        });
        const headers = { authorization: "Bearer " + bearer.secret };
        assert.equal(
          (await http("/api/bootstrap", undefined, headers)).status,
          200,
        );
        for (const path of [
          "/api/fleet/admin/state",
          "/api/agent-sources/" +
            encodeURIComponent("peer:" + source.identity.machineId) +
            "/workspace",
        ])
          assert.equal((await http(path, undefined, headers)).status, 403);
        assert.equal(
          (
            await protocol(
              fleetWorkspaceApi.catalog.path,
              { version: 1, requestId: randomUUID(), credential: read },
              { ...headers, cookie },
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await protocol(
              fleetMailApi.directory.path,
              {
                version: 1,
                requestId: randomUUID(),
                credential: await token("mail"),
                query: {},
              },
              { ...headers, cookie },
            )
          ).status,
          403,
        );
      },
    );
    await t.test(
      "mounted mail discovery requires its own grant and excludes foreign owners",
      async () => {
        const input = {
          version: 1,
          requestId: randomUUID(),
          credential: await token("mail"),
          query: {},
        };
        const listed = await protocol(fleetMailApi.directory.path, input);
        assert.equal(listed.status, 200);
        assert.deepEqual(listed.body.response.page, {
          agents: [],
          nextOffset: null,
        });
        assert(!JSON.stringify(listed.body).includes(foreignAgent));
        assert.equal(
          (
            await protocol(fleetMailApi.directory.path, {
              ...input,
              credential: read,
            })
          ).status,
          403,
        );
        assert.equal(
          (await protocol(fleetMailApi.directory.path, input, { cookie }))
            .status,
          403,
        );
      },
    );
    await t.test(
      "mounted projections and mutations cannot cross the local owner boundary",
      async () => {
        const bootstrap = await protocol(fleetWorkspaceApi.read.path, {
          version: 1,
          requestId: randomUUID(),
          credential: read,
          input: { route: "bootstrap", params: {}, query: {} },
        });
        assert.equal(bootstrap.status, 200);
        assert(!JSON.stringify(bootstrap.body).includes(foreignAgent));
        const denied = await protocol(fleetWorkspaceActionApi.action.path, {
          version: 1,
          requestId: randomUUID(),
          credential: act,
          commandId: randomUUID(),
          input: {
            route: "agentUpdate",
            params: { id: foreignAgent },
            body: { instructions: "changed" },
          },
        });
        assert.equal(denied.status, 200);
        assert.equal(denied.body.response.receipt.state, "refused");
        assert.deepEqual(
          db
            .prepare("SELECT owner_id,instructions FROM agents WHERE id=?")
            .get(foreignAgent),
          { owner_id: foreignOwner, instructions: "untouched" },
        );
      },
    );
    await t.test(
      "catalog grants only mounted named operations and refuses browser credentials",
      async () => {
        const input = { version: 1, requestId: randomUUID(), credential: read };
        const catalog = await protocol(fleetWorkspaceApi.catalog.path, input);
        assert.equal(catalog.status, 200);
        assert.equal(catalog.body.catalog.files, true);
        assert.equal(catalog.body.catalog.events, true);
        assert(catalog.body.catalog.actions.includes("folderCreate"));
        assert(catalog.body.catalog.actions.includes("uploadCreate"));
        assert(!catalog.body.catalog.actions.includes("connectionCreate"));
        assert.equal(
          (await protocol(fleetWorkspaceApi.catalog.path, input, { cookie }))
            .status,
          403,
        );
        assert.equal(
          (
            await http(
              "/api/agent-sources/" +
                encodeURIComponent("peer:" + source.identity.machineId) +
                "/workspace",
            )
          ).status,
          401,
        );
      },
    );
    await t.test(
      "mounted previews require device authorization or a read proof and retain the owning workspace",
      async () => {
        const foreignFolder = randomUUID();
        db.prepare(
          "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,?,NULL,'folder','Foreign preview fixture',1)",
        ).run(foreignFolder, foreignOwner);
        const before = db
          .prepare("SELECT count(*) n FROM fleet_command_receipts")
          .get();
        for (const route of ["routingPreview", "sharePreview"] as const) {
          const body =
            route === "routingPreview"
              ? { input: "Suggest an agent" }
              : { question: "Inspect a shared fixture" };
          const path =
            "/api/agent-sources/" +
            encodeURIComponent("peer:" + source.identity.machineId) +
            (route === "routingPreview"
              ? "/routing/preview"
              : "/share/preview");
          assert.equal((await http(path, body, { origin })).status, 401);
          assert.equal(
            (await http(path, body, { origin, cookie })).status,
            403,
          );
          assert.equal(
            (
              await http(path, body, {
                origin: "https://foreign.example",
                cookie,
                "x-loop55-csrf": csrf,
              })
            ).status,
            403,
          );
          const preview = {
            version: 1,
            requestId: randomUUID(),
            credential: read,
            input: { route, params: {}, query: {}, body },
          };
          const allowed = await protocol(fleetWorkspaceApi.read.path, preview, {
            "x-owner": foreignOwner,
            "x-loop55-owner": foreignOwner,
          });
          assert.equal(allowed.status, 200);
          assert(!JSON.stringify(allowed.body).includes(foreignAgent));
          assert.equal(
            (
              await protocol(fleetWorkspaceApi.read.path, {
                ...preview,
                input: {
                  ...preview.input,
                  body: { ...body, folderId: foreignFolder },
                },
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await protocol(fleetWorkspaceApi.read.path, {
                ...preview,
                credential: act,
              })
            ).status,
            403,
          );
          assert.equal(
            (await protocol(fleetWorkspaceApi.read.path, preview, { cookie }))
              .status,
            403,
          );
        }
        assert.deepEqual(
          db.prepare("SELECT count(*) n FROM fleet_command_receipts").get(),
          before,
        );
      },
    );
    const input = {
      route: "folderCreate",
      params: {},
      body: { name: "Remote-created project", parentId: null, kind: "folder" },
    };
    const commandId = randomUUID(),
      payloadDigest = fleetPayloadDigest(input);
    const action = {
      version: 1,
      requestId: randomUUID(),
      credential: act,
      commandId,
      input,
    };
    let folderId: string;
    await t.test(
      "owning write and public read use the companion owner and one durable command",
      async () => {
        const accepted = await protocol(
          fleetWorkspaceActionApi.action.path,
          action,
        );
        assert.equal(accepted.status, 200);
        assert.equal(accepted.body.response.receipt.state, "completed");
        folderId = accepted.body.response.receipt.result.id;
        assert.equal(
          (
            db
              .prepare("SELECT owner_id FROM folders WHERE id=?")
              .get(folderId) as { owner_id: string }
          ).owner_id,
          OWNER,
        );
        const repeated = await protocol(fleetWorkspaceActionApi.action.path, {
          ...action,
          requestId: randomUUID(),
        });
        assert.equal(repeated.body.response.receipt.result.id, folderId);
        assert.equal(
          (
            db
              .prepare(
                "SELECT count(*) n FROM folders WHERE name='Remote-created project'",
              )
              .get() as { n: number }
          ).n,
          1,
        );
        const listed = await protocol(fleetWorkspaceApi.read.path, {
          version: 1,
          requestId: randomUUID(),
          credential: read,
          input: { route: "folderList", params: {}, query: {} },
        });
        assert.equal(listed.status, 200);
        assert(
          listed.body.response.result.some(
            (row: { id: string }) => row.id === folderId,
          ),
        );
        const wrongScope = await protocol(fleetWorkspaceActionApi.action.path, {
          ...action,
          commandId: randomUUID(),
          credential: read,
        });
        assert.equal(wrongScope.status, 403);
      },
    );
    await t.test(
      "device-only receipt works on the owning companion without replaying a command",
      async () => {
        const query = {
          peer: host.fleet!.identity.machineId,
          commandId,
          route: input.route,
          payloadDigest,
        };
        const denied = await http(
          "/api" + fleetGatewayApi.receipt.path,
          query,
          { origin },
        );
        assert.equal(denied.status, 401);
        const receipt = await http(
          "/api" + fleetGatewayApi.receipt.path,
          query,
          { origin, cookie, "x-loop55-csrf": csrf },
        );
        assert.equal(receipt.status, 200);
        assert.equal(receipt.body.state, "completed");
        assert.equal(receipt.body.result.id, folderId);
      },
    );
    await t.test(
      "upload commit uses the owning producer and its bytes download through fixed file endpoints",
      async () => {
        const bytes = Buffer.from("Fixture owner-bound upload");
        const upload = {
          route: "uploadCreate",
          params: {},
          body: {
            options: { folderId: folderId! },
            file: {
              name: "fixture.txt",
              mime: "text/plain",
              size: bytes.length,
              checksum: createHash("sha256").update(bytes).digest("hex"),
            },
          },
        };
        const base = {
          version: 1,
          requestId: randomUUID(),
          credential: files,
          commandId: randomUUID(),
        };
        const prepared = await protocol(fleetWorkspaceUploadApi.prepare.path, {
          ...base,
          input: upload,
        });
        assert.equal(prepared.status, 200);
        const transferId = prepared.body.response.transferId;
        const chunk = await protocol(fleetWorkspaceUploadApi.chunk.path, {
          ...base,
          requestId: randomUUID(),
          transferId,
          payloadDigest: fleetPayloadDigest(upload),
          offset: 0,
          base64: bytes.toString("base64"),
        });
        assert.equal(chunk.status, 200);
        const committed = await protocol(fleetWorkspaceUploadApi.commit.path, {
          ...base,
          requestId: randomUUID(),
          transferId,
          input: upload,
        });
        assert.equal(committed.status, 200);
        assert.equal(committed.body.response.receipt.state, "completed");
        const file = committed.body.response.receipt.result;
        assert.equal(file.size, bytes.length);
        assert.equal(
          (
            db
              .prepare("SELECT owner_id FROM artifacts WHERE id=?")
              .get(file.id) as { owner_id: string }
          ).owner_id,
          OWNER,
        );
        const opened = await protocol(fleetWorkspaceFileApi.open.path, {
          version: 1,
          requestId: randomUUID(),
          credential: files,
          selection: {
            route: "objectFile",
            params: { id: file.objectId },
            query: {},
          },
        });
        assert.equal(opened.status, 200);
        const downloaded = await protocol(fleetWorkspaceFileApi.chunk.path, {
          version: 1,
          requestId: randomUUID(),
          credential: files,
          transferId: opened.body.response.transferId,
          offset: 0,
        });
        assert.equal(downloaded.status, 200);
        assert(
          Buffer.from(downloaded.body.response.base64, "base64").equals(bytes),
        );
      },
    );
    await t.test(
      "gateway verifies original event payloads before normalizing newer events and rejects tampering or replay",
      async () => {
        const fetcher: typeof PeerFetch = async (url, options) => {
          const target = new URL(String(url));
          assert.equal(target.origin, origin);
          const result = await http(
            target.pathname,
            JSON.parse(String(options!.body)),
            { "x-loop55-fleet-version": "1" },
          );
          return new PeerResponse(JSON.stringify(result.body), {
            status: result.status,
            headers: { "content-type": "application/json" },
          });
        };
        const budget = new FleetCapacity(() => true);
        const leases = new FleetCredentialLeases(
          source,
          sourceCredentials,
          sourceOwner,
          new FleetCredentialHttpTransport(fetcher, budget),
        );
        const reads = new FleetPeerReads(
          source,
          leases,
          sourceOwner,
          new FleetWorkspaceHttpTransport(fetcher, budget),
        );
        let connection: WebSocket | undefined;
        let signed: Buffer | undefined;
        const transport = new FleetWorkspaceEventHttpTransport(
          fetcher,
          budget,
          (_url, options) => {
            const { lookup: _lookup, ...localOptions } = options;
            signed = undefined;
            connection = new WebSocket(
              `ws://127.0.0.1:${host.gateway.port}${FLEET_EVENTS_PATH}`,
              {
                ...localOptions,
                headers: { ...options.headers, host: new URL(origin).host },
              },
            );
            connection.once("message", (raw) => {
              signed = Buffer.from(raw as Buffer);
            });
            return connection;
          },
        );
        const events = new FleetPeerEvents(
          source,
          leases,
          sourceOwner,
          reads,
          transport,
        );
        class Sink extends EventEmitter {
          readyState: number = WebSocket.OPEN;
          bufferedAmount = 0;
          frames: unknown[] = [];
          send(text: string) {
            this.frames.push(JSON.parse(text));
          }
          close() {
            if (this.readyState === WebSocket.CLOSED) return;
            this.readyState = WebSocket.CLOSED;
            this.emit("close");
          }
        }
        const sinks: Sink[] = [];
        try {
          const compatible = new Sink();
          sinks.push(compatible);
          await events.connect(
            compatible,
            host.fleet!.identity.machineId,
            new URLSearchParams(),
          );
          await waitFor(() => compatible.frames.length > 0);
          assert(signed);
          const initial = JSON.parse(signed.toString()).response;
          const future = {
            ...initial,
            sequence: initial.sequence + 1,
            frame: {
              v: 3,
              type: "events",
              epoch: initial.frame.epoch,
              cursor: initial.frame.cursor + 1,
              events: [
                {
                  id: initial.frame.cursor + 1,
                  event: {
                    type: "future.detail",
                    scope: { kind: "conversation", id: "future-thread" },
                    payload: { text: "FUTURE PRIVATE" },
                  },
                },
              ],
            },
          };
          const proof = new FleetProof(db, host.fleet!.identity, secrets);
          connection!.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                response: future,
                signature: proof.sign("workspace-event", future),
              }),
            ),
            false,
          );
          await waitFor(
            () =>
              compatible.frames.length === 2 ||
              compatible.readyState === WebSocket.CLOSED,
          );
          assert.equal(
            compatible.readyState,
            WebSocket.OPEN,
            "a valid newer signed event must retain the source connection",
          );
          assert.equal(compatible.frames.length, 2);
          assert.deepEqual(compatible.frames[1], {
            ...future.frame,
            events: [
              {
                id: future.frame.cursor,
                event: {
                  type: "invalidate",
                  scope: { kind: "collection", id: "all" },
                },
              },
            ],
          });
          assert(!JSON.stringify(compatible.frames).includes("FUTURE PRIVATE"));
          // Both bodies normalize to the same invalidation. Their signatures
          // must still authenticate the original bytes' canonical JSON value.
          future.sequence++;
          future.frame.cursor++;
          future.frame.events[0].id++;
          const signature = proof.sign("workspace-event", future);
          future.frame.events[0].event.payload.text = "TAMPERED PRIVATE";
          connection!.emit(
            "message",
            Buffer.from(JSON.stringify({ response: future, signature })),
            false,
          );
          await waitFor(
            () =>
              compatible.readyState === WebSocket.CLOSED &&
              budget.snapshot().outbound === 0,
          );
          assert.equal(compatible.frames.length, 2);
          for (const fault of ["signature", "replay"] as const) {
            const sink = new Sink();
            sinks.push(sink);
            await events.connect(
              sink,
              host.fleet!.identity.machineId,
              new URLSearchParams(),
            );
            await waitFor(() => sink.frames.length > 0);
            assert.equal((sink.frames[0] as { type: string }).type, "reset");
            assert.equal(budget.snapshot().outbound, 1);
            const prior = sink.frames.length;
            assert(signed);
            // Feed captured, well-formed wire frames through the actual caller:
            // changing a payload must fail the signature; unchanged old sequence
            // numbers must not be forwarded a second time.
            const forged = JSON.parse(signed.toString());
            forged.response.sequence++;
            forged.response.frame.cursor++;
            connection!.emit(
              "message",
              fault === "replay" ? signed : Buffer.from(JSON.stringify(forged)),
              false,
            );
            await waitFor(
              () =>
                sink.readyState === WebSocket.CLOSED &&
                budget.snapshot().outbound === 0,
            );
            assert.equal(sink.frames.length, prior);
          }
        } finally {
          for (const sink of sinks) sink.close();
          events.close();
          reads.close();
          leases.close();
          connection?.terminate();
        }
      },
    );
    await t.test(
      "machine event admission, owner projection, replay and revocation use the actual gateway",
      async () => {
        const credential = await token("events");
        const sockets: WebSocket[] = [];
        const connect = (
          headers: Record<string, string> = {},
          path = FLEET_EVENTS_PATH,
        ) => {
          const ws = new WebSocket(
            `ws://127.0.0.1:${host.gateway.port}${path}`,
            {
              headers: {
                host: new URL(origin).host,
                "x-loop55-fleet-version": "1",
                authorization: `Bearer ${credential}`,
                ...headers,
              },
            },
          );
          sockets.push(ws);
          ws.on("error", () => {});
          return ws;
        };
        try {
          for (const [headers, path] of [
            [{ authorization: `Bearer ${read}` }, FLEET_EVENTS_PATH],
            [{ cookie }, FLEET_EVENTS_PATH],
            [{ origin }, FLEET_EVENTS_PATH],
            [{ "sec-fetch-site": "same-origin" }, FLEET_EVENTS_PATH],
            [{}, FLEET_EVENTS_PATH + "?owner=" + foreignOwner],
            [{}, "/api/events/ws"],
          ] as [Record<string, string>, string][]) {
            const ws = connect(headers, path);
            const [, response] = await once(ws, "unexpected-response");
            assert.equal(response.statusCode, 403);
            ws.terminate();
          }
          for (const malformed of ["{", JSON.stringify({ version: 1 })]) {
            const ws = connect();
            await once(ws, "open");
            let frames = 0;
            ws.on("message", () => frames++);
            const closed = once(ws, "close");
            ws.send(malformed);
            const [code] = await closed;
            assert.equal(code, 1008);
            assert.equal(frames, 0);
            await waitFor(() => host.fleetCapacity!.snapshot().peer === 0);
          }
          const outboundBudget = new FleetCapacity(() => true);
          let connections = 0;
          const transport = new FleetWorkspaceEventHttpTransport(
            undefined,
            outboundBudget,
            (url, options) => {
              connections++;
              assert.equal(
                url.href,
                origin.replace("https:", "wss:") + FLEET_EVENTS_PATH,
              );
              assert.equal(options.followRedirects, false);
              assert.equal(options.perMessageDeflate, false);
              assert.equal(typeof options.lookup, "function");
              assert(!Object.hasOwn(options.headers!, "cookie"));
              assert(!Object.hasOwn(options.headers!, "origin"));
              // Explicit fixture adapter only: production keeps TLS and guarded DNS.
              const { lookup: _lookup, ...localOptions } = options;
              const socket = new WebSocket(
                `ws://127.0.0.1:${host.gateway.port}${FLEET_EVENTS_PATH}`,
                {
                  ...localOptions,
                  headers: { ...options.headers, host: new URL(origin).host },
                },
              );
              sockets.push(socket);
              return socket;
            },
          );
          const abort = new AbortController();
          await assert.rejects(async () =>
            transport.connect("https://127.0.0.1", credential, abort.signal),
          );
          assert.equal(connections, 0);
          await assert.rejects(transport.connect(origin, read, abort.signal), {
            status: 403,
          });
          await waitFor(() => outboundBudget.snapshot().outbound === 0);
          const ws = await transport.connect(origin, credential, abort.signal);
          const frames: ReturnType<typeof SignedFleetEventResponse.parse>[] =
            [];
          ws.on("message", (data) =>
            frames.push(
              SignedFleetEventResponse.parse(JSON.parse(data.toString())),
            ),
          );
          assert.equal(outboundBudget.snapshot().outbound, 1);
          const request = {
            version: 1,
            requestId: randomUUID(),
            epoch: "",
            cursor: 0,
            conversations: [] as string[],
            runs: [] as string[],
          };
          ws.send(JSON.stringify(request));
          await waitFor(() => frames.length > 0);
          const first = frames[0].response.frame;
          assert.equal(first.type, "reset");
          assert.equal(host.fleetCapacity!.snapshot().peer, 1);
          const insert = db.prepare(
            "INSERT INTO events(owner_id,run_id,type,payload,subject_kind,subject_id,created_at) VALUES(?,NULL,'message.delta',?,'conversation',?,1)",
          );
          insert.run(
            foreignOwner,
            JSON.stringify({ messageId: "foreign", text: "FOREIGN PRIVATE" }),
            "other-thread",
          );
          const closed = Number(
            insert.run(
              OWNER,
              JSON.stringify({ messageId: "closed", text: "CLOSED PRIVATE" }),
              "closed-thread",
            ).lastInsertRowid,
          );
          changes.wake();
          await waitFor(() =>
            frames.some((entry) => entry.response.frame.cursor >= closed),
          );
          assert(!JSON.stringify(frames).includes("FOREIGN PRIVATE"));
          assert(!JSON.stringify(frames).includes("CLOSED PRIVATE"));
          assert(
            frames
              .flatMap((entry) =>
                entry.response.frame.type === "events"
                  ? entry.response.frame.events
                  : [],
              )
              .some(
                (entry) =>
                  entry.id === closed && entry.event.type === "invalidate",
              ),
          );
          for (const [sequence, entry] of frames.entries()) {
            assert.equal(entry.response.sequence, sequence);
            assert.equal(entry.response.requestId, request.requestId);
            assert.equal(entry.response.peer, source.identity.machineId);
            assert.equal(entry.response.directory, head);
            assert(
              verifyFleetProof(
                host.fleet!.identity,
                "workspace-event",
                entry.response,
                entry.signature,
              ),
            );
          }
          frames.length = 0;
          const replay = {
            ...request,
            requestId: randomUUID(),
            epoch: first.epoch,
            cursor: first.cursor,
            conversations: ["closed-thread"],
          };
          ws.send(JSON.stringify(replay));
          await waitFor(() =>
            frames.some((entry) => entry.response.frame.cursor >= closed),
          );
          assert(JSON.stringify(frames).includes("CLOSED PRIVATE"));
          assert(!JSON.stringify(frames).includes("FOREIGN PRIVATE"));
          assert.equal(frames[0].response.sequence, 0);
          assert.equal(frames[0].response.requestId, replay.requestId);
          // A committed directory change fences an open stream without waiting
          // for a browser request, heartbeat, or ten-minute credential expiry.
          const departed = source.revise(sourceOwner, {
            mutationId: randomUUID(),
            expected: head,
            members: [directory.document.members[0]],
          });
          const ended = once(ws, "close");
          host.fleet!.accept(OWNER, departed);
          const [code] = await ended;
          assert.equal(code, 4001);
          await waitFor(() => host.fleetCapacity!.snapshot().peer === 0);
          assert.equal(outboundBudget.snapshot().outbound, 0);
        } finally {
          for (const ws of sockets) ws.terminate();
        }
      },
    );
    await host.close();
    assert.throws(
      () =>
        host.fleetWorkspace!.workspaceRead.catalog({
          version: 1,
          requestId: randomUUID(),
          credential: read,
        }),
      /does not admit fleet reads/,
    );
    await assert.rejects(
      host.fleetWorkspace.reads.catalog(source.identity.machineId),
      /not an authorized fleet source/,
    );
  } finally {
    await host.close();
    await nativeSessions.close();
    await closeExecution();
    sourceDb.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
