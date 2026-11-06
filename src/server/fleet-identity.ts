import * as identityQueries from "./sql/fleet-machine-identity.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { MachineIdentity } from "../shared/fleet.js";
import { generateMachineKey, identityFromPrivateKey } from "./fleet-crypto.js";

type SecretStorage = {
  seal: (value: string, context: string) => string;
  unseal: (value: string, context: string) => string;
};
const IdentityRow = z.object({
  machine_id: MachineIdentity.shape.machineId,
  public_key: MachineIdentity.shape.publicKey,
  private_key: z.string().min(1),
});

/** Called only by the companion gateway, never an isolated preview.
 * The returned projection intentionally contains no signing material. */
export function initializeFleetIdentity(
  db: Database.Database,
  secrets: SecretStorage,
): MachineIdentity {
  return db
    .transaction(() => {
      const row = identityQueries.saved(db);
      if (row) {
        const saved = IdentityRow.parse(row);
        const identity = identityFromPrivateKey(
          secrets.unseal(
            saved.private_key,
            `fleet:machine:${saved.machine_id}`,
          ),
        );
        if (
          identity.machineId !== saved.machine_id ||
          identity.publicKey !== saved.public_key
        )
          throw new Error(
            "Fleet machine identity is inconsistent; explicit recovery is required.",
          );
        return identity;
      }
      const { identity, privateKey } = generateMachineKey();
      identityQueries.insert(
        db,
        identity.machineId,
        identity.publicKey,
        secrets.seal(privateKey, `fleet:machine:${identity.machineId}`),
        Date.now(),
      );
      return identity;
    })
    .immediate();
}
