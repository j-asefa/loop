import type Database from "better-sqlite3";
import { z } from "zod";
import { MachineId } from "../shared/fleet.js";
import { Problem } from "../shared/problem.js";
import { FleetActionReceipt } from "../shared/fleet-workspace-action-api.js";
import {
  FleetCommandRoute,
  fleetCommandRoutes,
  type FleetCommandReference,
} from "../shared/fleet-command-api.js";

type Receipt = z.infer<typeof FleetActionReceipt>;
const Stored = z.object({
  peer_id: MachineId,
  fleet_id: z.string().uuid(),
  grant_id: z.string().uuid(),
  route: FleetCommandRoute,
  payload_digest: z.string().regex(/^[a-f0-9]{64}$/),
  state: FleetActionReceipt.shape.state,
  result: z.string().nullable(),
});
type Target = {
  member: { machineId: string; grantId: string };
  fleetId: string;
};

/** One durable owner/command namespace covers JSON actions and uploads. A
 * receipt-only visit claims unknown before contacting the destination, and a
 * late pending result cannot downgrade a terminal receipt. No bodies or tokens
 * are retained; bounded public results may compact without evicting identities. */
export class FleetForwardedCommands {
  constructor(
    private readonly db: Database.Database,
    private readonly owner: string,
  ) {}
  stored(commandId: string) {
    const row = this.db
      .prepare(
        "SELECT * FROM fleet_forwarded_actions WHERE owner_id=? AND command_id=?",
      )
      .get(this.owner, commandId);
    return row ? Stored.parse(row) : undefined;
  }
  match(
    row: z.infer<typeof Stored>,
    target: Target,
    input: FleetCommandReference,
    digest: string,
  ) {
    if (
      row.peer_id !== target.member.machineId ||
      row.fleet_id !== target.fleetId ||
      row.grant_id !== target.member.grantId ||
      row.route !== input.route ||
      row.payload_digest !== digest
    )
      throw new Problem(
        409,
        "This command belongs to another destination, grant or action. Keep its original receipt.",
      );
  }
  claim(
    commandId: string,
    target: Target,
    input: FleetCommandReference,
    digest: string,
  ) {
    return this.db
      .transaction(() => {
        const prior = this.stored(commandId);
        if (prior) {
          this.match(prior, target, input, digest);
          return false;
        }
        const now = Date.now();
        this.db
          .prepare(
            "INSERT INTO fleet_forwarded_actions VALUES(?,?,?,?,?,?,?,'unknown',NULL,?,?)",
          )
          .run(
            this.owner,
            commandId,
            target.member.machineId,
            target.fleetId,
            target.member.grantId,
            input.route,
            digest,
            now,
            now,
          );
        return true;
      })
      .immediate();
  }
  view(commandId: string, row: z.infer<typeof Stored>): Receipt {
    return {
      commandId,
      state: row.state,
      result:
        row.result === null
          ? null
          : fleetCommandRoutes[row.route].response.parse(
              JSON.parse(row.result),
            ),
    };
  }
  save(commandId: string, receipt: Receipt) {
    const json =
      receipt.result === null ? null : JSON.stringify(receipt.result);
    const result =
      json !== null && Buffer.byteLength(json) <= 64 * 1024 ? json : null;
    this.db
      .transaction(() => {
        this.db
          .prepare(
            "UPDATE fleet_forwarded_actions SET state=?,result=?,updated_at=? WHERE owner_id=? AND command_id=? AND state IN ('unknown','started')",
          )
          .run(receipt.state, result, Date.now(), this.owner, commandId);
        this.db
          .prepare(
            `UPDATE fleet_forwarded_actions SET result=NULL WHERE owner_id=? AND result IS NOT NULL AND rowid NOT IN
        (SELECT rowid FROM fleet_forwarded_actions WHERE owner_id=? AND result IS NOT NULL ORDER BY updated_at DESC,rowid DESC LIMIT 64)`,
          )
          .run(this.owner, this.owner);
      })
      .immediate();
    return this.view(commandId, this.stored(commandId)!);
  }
}
