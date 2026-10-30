import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request, type IncomingHttpHeaders } from "node:http";
import Database from "better-sqlite3";

// WorkspaceHost loads the real application: set its isolated profile first.
const root = mkdtempSync(join(tmpdir(), "loop-fleet-workspace-host-"));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
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
const { db } = await import("../src/server/db.js");
const { OWNER, nativeSessions } =
  await import("../src/server/native-sessions.js");
const { closeExecution } = await import("../src/server/execution-client.js");
const secrets = await import("../src/server/secrets.js");
const { createCardToken } = await import("../src/server/card-tokens.js");
const origin = "https://workspace.example";
const host = new WorkspaceHost(
  root,
  {
    harness: "codex",
    executable: process.execPath,
    project: root,
    version: "fixture",
    billing: "existing",
  },
  { open: async () => {}, schedule: async () => {}, close: async () => {} },
);
const sourceDb = new Database(":memory:");
applyMigrations(sourceDb);
sourceDb.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
const source = new FleetAuthority(sourceDb, secrets),
  sourceOwner = randomUUID();
const sourceCredentials = new FleetCredentials(sourceDb, source, secrets);
const scope = ["read", "act", "files"] as const;
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
) => http("/api" + path, input, { "x-loop-fleet-version": "1", ...headers });
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

test("WorkspaceHost mounts owner-bound sources, reads, actions, files and device receipts", async (t) => {
  try {
    assert(host.fleetWorkspace);
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
      "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,instructions,origin,created_at) VALUES(?,?,'Foreign','foreign','openai','fixture','untouched','loop',0)",
    ).run(foreignAgent, foreignOwner);
    await t.test(
      "workspace integration tokens cannot become peer or device credentials",
      async () => {
        const bearer = createCardToken(OWNER, {
          request_id: randomUUID(),
          name: "Local read fixture",
          secret: "loop_token_" + randomBytes(32).toString("base64url"),
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
        assert.equal(catalog.body.catalog.events, false);
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
                "x-loop-csrf": csrf,
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
            "x-loop-owner": foreignOwner,
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
          { origin, cookie, "x-loop-csrf": csrf },
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
