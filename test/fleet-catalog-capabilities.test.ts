import { afterAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter, once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetCredentials } from "../src/server/fleet-credentials.js";
import { FleetWorkspaceRead } from "../src/server/fleet-workspace-read.js";
import { FleetWorkspaceApp } from "../src/server/fleet-workspace-app.js";
import { directoryDigest } from "../src/server/fleet-crypto.js";
import { FleetProof, verifyFleetProof } from "../src/server/fleet-proof.js";
import { FleetCredentialLeases } from "../src/server/fleet-credential-leases.js";
import { FleetPeerReads } from "../src/server/fleet-peer-reads.js";
import { FleetPeerEvents } from "../src/server/fleet-peer-events.js";
import { FleetWorkspaceEventHttpTransport } from "../src/server/fleet-workspace-event-http.js";
import { FleetEventSubscription } from "../src/shared/fleet-workspace-events.js";
import type { FleetEnrollmentProbe } from "../src/shared/fleet-enrollment.js";
import { COMPLETE_WORKSPACE_CAPABILITIES } from "../src/shared/workspace-events.js";
import { until } from "./helpers.js";
import type { FleetOperation } from "../src/shared/fleet.js";

const root = mkdtempSync(join(tmpdir(), "loop55-fleet-catalog-"));
process.env.LOOP55_PROFILE = "companion";
process.env.LOOP55_DATA_DIR = root;
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const secrets = await import("../src/server/secrets.js");
const databases: Database.Database[] = [];
afterAll(() => {
  for (const db of databases) db.close();
  rmSync(root, { recursive: true, force: true });
});
function machine() {
  const db = new Database(join(root, randomUUID() + ".db"));
  applyMigrations(db);
  db.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
  databases.push(db);
  const authority = new FleetAuthority(db, secrets);
  return {
    db,
    authority,
    owner: randomUUID(),
    credentials: new FleetCredentials(db, authority, secrets),
  };
}

it.each<FleetOperation[]>([["read"], ["act"], ["read", "act"]])(
  "advertises only the locally consented operations for %s",
  (...scope) => {
    const a = machine(),
      b = machine();
    const first = a.authority.create(a.owner, {
      mutationId: randomUUID(),
      name: "Gateway",
      origin: "https://gateway.example",
      scope: ["read", "act"],
    });
    const grantId = randomUUID();
    const directory = a.authority.revise(a.owner, {
      mutationId: randomUUID(),
      expected: directoryDigest(first.document),
      members: [
        ...first.document.members,
        {
          ...b.authority.identity,
          name: "Destination",
          origin: "https://destination.example",
          grantId,
        },
      ],
    });
    b.authority.approve(b.owner, {
      mutationId: randomUUID(),
      expected: null,
      kind: "enroll",
      scope,
      controller: a.authority.identity,
      directory,
      grantId,
    });
    const proof = a.credentials.prove(
      a.owner,
      b.credentials.challenge({
        fleetId: directory.document.fleetId,
        grantId,
        destination: b.authority.identity.machineId,
        peer: a.authority.identity.machineId,
        directory: directoryDigest(directory.document),
        operation: scope[0],
      }),
    );
    const credential = a.credentials.accept(
      a.owner,
      proof,
      b.credentials.issue(proof),
    ).token;
    const service = new FleetWorkspaceRead(
      b.db,
      b.authority,
      b.credentials,
      b.owner,
      new FleetWorkspaceApp((_req, res) => {
        res.end();
      }, b.owner),
      secrets,
      { actions: () => ["submit", "nativeAnswer"] },
    );
    try {
      const response = service.catalog({
        version: 1,
        requestId: randomUUID(),
        credential,
      });
      expect(
        verifyFleetProof(
          b.authority.identity,
          "workspace-catalog",
          response.catalog,
          response.signature,
        ),
      ).toBe(true);
      expect(response.catalog.reads.length > 0).toBe(scope.includes("read"));
      expect(response.catalog.actions).toEqual(
        scope.includes("act") ? ["submit", "nativeAnswer"] : [],
      );
      expect(response.catalog.events).toBe(false);
      expect(response.catalog.files).toBe(false);
      b.db.prepare("UPDATE deployment_profile SET profile='server'").run();
      expect(() =>
        service.catalog({ version: 1, requestId: randomUUID(), credential }),
      ).toThrow("does not admit");
    } finally {
      service.close();
    }
  },
);

it("subscribes with an events-only grant without acquiring read permission", async () => {
  const a = machine(),
    b = machine();
  const first = a.authority.create(a.owner, {
    mutationId: randomUUID(),
    name: "Gateway",
    origin: "https://gateway.example",
    scope: ["events"],
  });
  const grantId = randomUUID();
  const directory = a.authority.revise(a.owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(first.document),
    members: [
      ...first.document.members,
      {
        ...b.authority.identity,
        name: "Events source",
        origin: "https://events.example",
        grantId,
      },
    ],
  });
  b.authority.approve(b.owner, {
    mutationId: randomUUID(),
    expected: null,
    kind: "enroll",
    scope: ["events"],
    controller: a.authority.identity,
    directory,
    grantId,
  });
  const operations: FleetOperation[] = [];
  const leases = new FleetCredentialLeases(
    a.authority,
    a.credentials,
    a.owner,
    {
      challenge: async (_origin, context) => {
        operations.push(context.operation);
        return b.credentials.challenge(context);
      },
      issue: async (_origin, proof) => b.credentials.issue(proof),
    },
  );
  const service = new FleetWorkspaceRead(
    b.db,
    b.authority,
    b.credentials,
    b.owner,
    new FleetWorkspaceApp((_req, res) => res.end(), b.owner),
    secrets,
    { events: true },
  );
  const proof = new FleetProof(b.db, b.authority.identity, secrets);
  const probe = async (_origin: string, input: FleetEnrollmentProbe) => ({
    probe: input,
    signature: proof.sign("enrollment-probe", input),
  });
  const reads = new FleetPeerReads(a.authority, leases, a.owner, {
    probe,
    catalog: async (_origin, input) => service.catalog(input),
    read: async (_origin, input) => service.read(input),
  });
  // Real subscription socket; only DNS/HTTP transport is local to this fixture.
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  let subscribed!: (value: unknown) => void;
  const subscription = new Promise((resolve) => {
    subscribed = resolve;
  });
  let upstream: WebSocket;
  server.on("connection", (socket) => {
    upstream = socket;
    socket.once("message", (data) => subscribed(JSON.parse(data.toString())));
  });
  const transport = new (class extends FleetWorkspaceEventHttpTransport {
    override probe = probe;
    override async connect(_origin: string, token: string) {
      expect(b.credentials.authenticate(token).context.operation).toBe(
        "events",
      );
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
      await once(socket, "open");
      return socket;
    }
  })();
  const sink = new (class extends EventEmitter {
    readyState: number = WebSocket.OPEN;
    bufferedAmount = 0;
    frames: unknown[] = [];
    send(text: string) {
      this.frames.push(JSON.parse(text));
    }
    close() {
      this.readyState = WebSocket.CLOSED;
      this.emit("close");
    }
  })();
  const events = new FleetPeerEvents(
    a.authority,
    leases,
    a.owner,
    reads,
    transport,
  );
  try {
    await events.connect(
      sink,
      b.authority.identity.machineId,
      new URLSearchParams(),
    );
    const request = FleetEventSubscription.parse(await subscription);
    expect(request).toMatchObject({
      version: 1,
      cursor: 0,
      conversations: [],
    });
    expect(operations).toEqual(["events"]);
    const response = {
      version: 1 as const,
      requestId: request.requestId,
      sequence: 0,
      machineId: b.authority.identity.machineId,
      peer: a.authority.identity.machineId,
      grantId,
      directory: directoryDigest(directory.document),
      frame: {
        v: 3 as const,
        type: "reset" as const,
        epoch: "fixture",
        cursor: 0,
        build: "fixture",
        buildIdentity: null,
        capabilities: COMPLETE_WORKSPACE_CAPABILITIES,
      },
    };
    upstream!.send(
      JSON.stringify({
        response,
        signature: proof.sign("workspace-event", response),
      }),
    );
    await until(() => sink.frames.length === 1);
    expect(sink.frames[0]).toMatchObject({
      type: "reset",
      epoch: "fixture",
      cursor: 0,
    });
    // A correctly shaped frame with a changed signed cursor must close before
    // any altered workspace data reaches the browser-facing sink.
    const next = { ...response, sequence: 1 };
    const signature = proof.sign("workspace-event", next);
    upstream!.send(
      JSON.stringify({
        response: { ...next, frame: { ...next.frame, cursor: 1 } },
        signature,
      }),
    );
    await until(() => sink.readyState === WebSocket.CLOSED);
    expect(sink.frames).toHaveLength(1);

    await expect(
      reads.read(b.authority.identity.machineId, {
        route: "bootstrap",
        params: {},
        query: {},
      }),
    ).rejects.toMatchObject({ status: 503 });
    const credential = await leases.get(
      b.authority.identity.machineId,
      "events",
    );
    await expect(
      service.read({
        version: 1,
        requestId: randomUUID(),
        credential: credential.token,
        input: { route: "bootstrap", params: {}, query: {} },
      }),
    ).rejects.toMatchObject({ status: 403 });
  } finally {
    events.close();
    reads.close();
    leases.close();
    service.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
