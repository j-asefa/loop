import * as pairingCeremoniesQueries from "./sql/pairing-ceremonies.js";
import type Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { hash } from "../state.js";
import { FleetCapabilities } from "../shared/fleet.js";
import { FleetSecret } from "../shared/fleet-credentials.js";
import { formatFleetPairLink } from "../shared/fleet-pairing.js";
import { Problem } from "../shared/problem.js";
import { FleetAuthority } from "./fleet-authority.js";
import { fleetPayloadDigest } from "./fleet-crypto.js";
import { Ceremony, DevicePairing, rejected } from "./device-pairing.js";

const Id = z.string().uuid();
const fullScope = FleetCapabilities.parse([
  "read",
  "act",
  "events",
  "mail",
  "files",
]);

/** Core device pairing plus fleet enrollment. A ceremony and the device or
 * pending enrollment grant it creates share one transaction. This class does
 * not expose a peer endpoint or trust a peer owner ID. */
export class FleetPairing extends DevicePairing {
  constructor(
    db: Database.Database,
    private readonly authority: FleetAuthority,
    owner: string,
    directory: string,
    wall: () => number = Date.now,
    monotonic: () => number = () => performance.now(),
  ) {
    super(db, owner, directory, wall, monotonic);
  }
  protected override ceremonyHead() {
    return this.authority.status(this.owner).head;
  }
  protected override extendedLink(link: {
    kind: "combined" | "enrollment";
    ceremonyId: string;
    origin: string;
    scope: readonly string[];
    enrollment: string;
    device?: string;
  }) {
    const common = {
      version: 1 as const,
      ceremonyId: link.ceremonyId,
      origin: link.origin,
      machine: this.authority.identity,
      scope: FleetCapabilities.parse(link.scope),
      enrollment: link.enrollment,
    };
    return formatFleetPairLink(
      link.kind === "combined"
        ? { ...common, kind: "combined", device: link.device! }
        : { ...common, kind: "enrollment" },
    );
  }
  override pair(origin: string) {
    return this.mint(
      origin,
      origin.startsWith("https:") ? "combined" : "device",
      fullScope,
    );
  }
  /** Local authenticated device administration only; never a peer operation. */
  enrollment(origin: string, scope = fullScope, recovery = false) {
    return this.mint(
      origin,
      "enrollment",
      FleetCapabilities.parse(scope),
      recovery,
    );
  }

  /** Used only after the enrollment protocol has authenticated the destination,
   * controller proof and bound request. `accept` performs synchronous writes to
   * this database only, including its pending grant. Never dispatch network or
   * native work here. The explicit response schema keeps receipts public. */
  consumeEnrollment<T>(
    input: {
      ceremonyId: string;
      secret: string;
      origin: string;
      operationId: string;
      request: unknown;
    },
    response: z.ZodType<T>,
    accept: (consent: {
      scope: z.infer<typeof FleetCapabilities>;
      expectedHead: string | null;
      mode: "enroll" | "repair" | "recover";
    }) => T,
  ): T {
    const value = z
      .object({
        ceremonyId: Id,
        secret: FleetSecret,
        origin: z.string().max(2048),
        operationId: Id,
        request: z.unknown(),
      })
      .strict()
      .parse(input);
    const digest = fleetPayloadDigest({
      purpose: "loop-fleet-pairing-operation-v1",
      request: value.request,
    });
    const now = this.now();
    return this.db
      .transaction(() => {
        const raw = pairingCeremoniesQueries.enrollment(
          this.db,
          value.ceremonyId,
          this.owner,
          hash(value.secret),
        );
        if (!raw) throw rejected();
        const ceremony = Ceremony.parse(raw);
        if (ceremony.origin !== value.origin) throw rejected();
        if (ceremony.state === "enrollment") {
          if (
            ceremony.operation_id !== value.operationId ||
            ceremony.payload_digest !== digest
          )
            throw new Problem(
              409,
              "This enrollment capability belongs to a different operation.",
            );
          return response.parse(JSON.parse(ceremony.result!));
        }
        if (
          ceremony.state !== "pending" ||
          ceremony.expires_at <= now ||
          !this.pendingAlive(ceremony.id)
        )
          throw rejected();
        if (
          pairingCeremoniesQueries.operationExists(
            this.db,
            this.owner,
            value.operationId,
          )
        )
          throw new Problem(409, "Enrollment operation ID is already bound.");
        const result = response.parse(
          accept({
            scope: FleetCapabilities.parse(JSON.parse(ceremony.scope)),
            expectedHead: ceremony.expected_head,
            mode: ceremony.mode,
          }),
        );
        const json = JSON.stringify(result);
        if (!json || Buffer.byteLength(json) > 64 * 1024)
          throw new Problem(413, "Enrollment receipt exceeds its bound.");
        pairingCeremoniesQueries.consumeEnrollment(
          this.db,
          value.operationId,
          digest,
          json,
          ceremony.id,
          this.owner,
        );
        return result;
      })
      .immediate();
  }
}
