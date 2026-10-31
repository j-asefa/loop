import { Problem } from "../shared/problem.js";
import { db } from "./db.js";
import type { FleetAuthority } from "./fleet-authority.js";
import type { FleetCredentials } from "./fleet-credentials.js";
import type { FleetCredentialLeases } from "./fleet-credential-leases.js";
import type { FleetCapacity } from "./fleet-capacity.js";
import { fleetMailPolicyHandlers } from "./agent-mail.js";
import { FleetMailDestination } from "./fleet-mail-destination.js";
import { FleetMailJournal } from "./fleet-mail-journal.js";
import {
  FleetMailHttpTransport,
  type FleetMailTransport,
} from "./fleet-mail-http.js";
import { FleetPeerMail } from "./fleet-peer-mail.js";
import { FleetMailDiscovery } from "./fleet-mail-discovery.js";
import { FleetMailDrainer } from "./fleet-mail-drainer.js";
import { installFleetMailTools } from "./fleet-mail-tools.js";
import {
  fleetMailWorkerService,
  type FleetMailWorkerService,
} from "./fleet-mail-worker-service.js";

/** The companion lifecycle owns these services and supplies the one tunnel
 * budget used by browser, workspace and mail traffic. Construction starts no
 * delivery and enables no tools. WorkspaceHost installs its private worker
 * bridge before opening execution, then starts delivery after listening. */
export class FleetMailServices {
  readonly destination: FleetMailDestination;
  readonly worker: FleetMailWorkerService;
  private readonly discovery: FleetMailDiscovery;
  private readonly drainer: FleetMailDrainer;
  private disable?: () => void;
  private stopped = false;
  private readonly subscriptions = new Set<() => void>();

  constructor(
    authority: FleetAuthority,
    credentials: FleetCredentials,
    leases: FleetCredentialLeases,
    private readonly owner: string,
    secrets: ConstructorParameters<typeof FleetMailDestination>[4],
    capacity: FleetCapacity,
    transport: FleetMailTransport = new FleetMailHttpTransport(
      undefined,
      capacity,
    ),
  ) {
    if (
      (
        db
          .prepare("SELECT profile FROM deployment_profile WHERE singleton=1")
          .get() as { profile: string } | undefined
      )?.profile !== "companion"
    )
      throw new Problem(403, "Fleet mail is unavailable in this workspace.");
    this.destination = new FleetMailDestination(
      db,
      authority,
      credentials,
      owner,
      secrets,
      fleetMailPolicyHandlers(owner),
    );
    const journal = new FleetMailJournal(db, authority, owner);
    const peer = new FleetPeerMail(
      authority,
      leases,
      owner,
      journal,
      transport,
    );
    this.discovery = new FleetMailDiscovery(authority, owner, peer);
    this.drainer = new FleetMailDrainer(authority, owner, journal, peer);
    const service = fleetMailWorkerService(owner, this.discovery);
    this.worker = {
      observe: (notify) => {
        if (this.stopped) return () => {};
        const stop = authority.observe(owner, notify);
        const dispose = () => {
          stop();
          this.subscriptions.delete(dispose);
        };
        this.subscriptions.add(dispose);
        return dispose;
      },
      sources: () => (this.stopped ? [] : service.sources()),
      read: (source, query, caller, current) => {
        const live = () => {
          if (this.stopped)
            throw new Problem(503, "Fleet mail has stopped in this workspace.");
          current();
        };
        live();
        return service.read(source, query, caller, live);
      },
    };
  }

  /** Call after the peer gateway is listening. Configure the private worker
   * bridge before execution.open(), so new workers inherit the same catalog. */
  start() {
    if (this.stopped || this.disable) return;
    this.disable = installFleetMailTools(this.owner, this.discovery);
    this.drainer.start();
  }

  close() {
    if (this.stopped) return;
    this.stopped = true;
    for (const dispose of this.subscriptions) dispose();
    this.disable?.();
    this.drainer.close();
    this.destination.close();
  }
}
