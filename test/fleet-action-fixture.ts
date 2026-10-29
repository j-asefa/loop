import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { FleetGrantContext } from "../src/shared/fleet.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { applyMigrations } from "../src/server/migrations.js";
import { directoryDigest } from "../src/server/fleet-crypto.js";
import { withFleetAction } from "../src/server/fleet-action-context.js";

export function fleetActor(
  owner: string,
  authority: FleetAuthority,
  secrets: ConstructorParameters<typeof FleetAuthority>[1],
  authorize: (owner: string, grant: FleetGrantContext) => void,
) {
  const peerDb = new Database(":memory:");
  applyMigrations(peerDb);
  peerDb.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
  const identity = new FleetAuthority(peerDb, secrets).identity;
  peerDb.close();
  const current = authority.directory(owner)!;
  const directory = authority.revise(owner, {
    mutationId: randomUUID(),
    expected: directoryDigest(current.document),
    members: [
      ...current.document.members,
      {
        ...identity,
        name: "Peer",
        origin: `https://${randomUUID()}.example`,
        grantId: randomUUID(),
      },
    ],
  });
  const grant = {
    fleetId: directory.document.fleetId,
    grantId: directory.document.members[0].grantId,
    destination: authority.identity.machineId,
    peer: identity.machineId,
    directory: directoryDigest(directory.document),
    operation: "act" as const,
  };
  return {
    act<T>(apply: () => T) {
      return withFleetAction(
        { owner, commandId: randomUUID(), grant },
        () => authorize(owner, grant),
        apply,
      );
    },
    revoke() {
      const current = authority.directory(owner)!;
      authority.revise(owner, {
        mutationId: randomUUID(),
        expected: directoryDigest(current.document),
        members: current.document.members.filter(
          (m) => m.machineId !== identity.machineId,
        ),
      });
    },
  };
}
