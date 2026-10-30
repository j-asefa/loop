import { afterAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetCredentials } from "../src/server/fleet-credentials.js";
import { FleetWorkspaceRead } from "../src/server/fleet-workspace-read.js";
import { FleetWorkspaceApp } from "../src/server/fleet-workspace-app.js";
import { directoryDigest } from "../src/server/fleet-crypto.js";
import { verifyFleetProof } from "../src/server/fleet-proof.js";
import type { FleetOperation } from "../src/shared/fleet.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-catalog-"));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = root;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
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
