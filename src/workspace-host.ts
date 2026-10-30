import { companionMode } from "./server/profile.js";
import {
  executionClient,
  executionRequest,
} from "./server/execution-client.js";
import {
  ExecutionProcess,
  type ExecutionLifecycle,
} from "./server/execution-process.js";
import { Host } from "./host.js";
import type { Options } from "./adapters/types.js";
import { app } from "./server/index.js";
import { db } from "./server/db.js";
import { config } from "./server/config.js";
import { nativeSessions, OWNER } from "./server/native-sessions.js";
import { RegistrationOptions } from "./shared/execution-authority.js";
import { connectWorkspaceEvents } from "./server/workspace-events.js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DockerMcpSharing } from "./mcp-docker-sharing.js";
import { preview, designPreview } from "./preview-context.js";
import { publicBuild } from "./shared/build.js";
import { observeProcess } from "./server/deployments.js";
import { observedBuild } from "./server/build-runtime.js";
import { authorizeIntegrationToken } from "./server/index.js";
import { createTokenEventSockets } from "./server/token-events.js";
import { FleetAuthority } from "./server/fleet-authority.js";
import { FleetPairing } from "./server/fleet-pairing.js";
import { FleetEnrollmentDestination } from "./server/fleet-enrollment.js";
import {
  FleetHandoffDestination,
  FleetHandoffSource,
} from "./server/fleet-handoff.js";
import { FleetHandoffHttpTransport } from "./server/fleet-handoff-http.js";
import { FleetDirectorySync } from "./server/fleet-directory-sync.js";
import { FleetPendingDirectory } from "./server/fleet-pending-directory.js";
import { FleetDistribution } from "./server/fleet-distribution.js";
import { FleetDirectoryHttpTransport } from "./server/fleet-directory-http.js";
import { FleetDirectoryReconcile } from "./server/fleet-directory-reconcile.js";
import { FleetCredentials } from "./server/fleet-credentials.js";
import { FleetCredentialLeases } from "./server/fleet-credential-leases.js";
import { FleetCredentialHttpTransport } from "./server/fleet-credential-http.js";
import { createFleetPeerHttp } from "./server/fleet-peer-http.js";
import { FleetEnrollmentSource } from "./server/fleet-enrollment-source.js";
import { FleetEnrollmentHttpTransport } from "./server/fleet-enrollment-http.js";
import { FleetLocalAdmin } from "./server/fleet-local-admin.js";
import { createFleetAdminHttp } from "./server/fleet-admin-http.js";
import { FleetWorkspaceServices } from "./server/fleet-workspace-services.js";
import { createFleetCommandsHttp } from "./server/fleet-commands-http.js";
import { AgentSources, dockerSourceAdapter } from "./agent-sources.js";
import { uploadFile } from "./server/uploads.js";
import { seal, unseal } from "./server/secrets.js";

// Identifies the browser assets this launch serves. A reconnecting page
// compares it to offer a reload without discarding its draft.
const BUILD = (() => {
  try {
    return createHash("sha256")
      .update(readFileSync(new URL("./web/index.html", import.meta.url)))
      .digest("hex")
      .slice(0, 12);
  } catch {
    return "development";
  }
})();
export class WorkspaceHost {
  gateway: Host;
  readonly fleet?: FleetAuthority;
  readonly pairing?: FleetPairing;
  readonly enrollment?: FleetEnrollmentDestination;
  readonly fleetAdmin?: FleetLocalAdmin;
  readonly fleetDistribution?: FleetDistribution;
  readonly fleetReconcile?: FleetDirectoryReconcile;
  readonly fleetCredentials?: FleetCredentials;
  readonly fleetLeases?: FleetCredentialLeases;
  readonly fleetWorkspace?: FleetWorkspaceServices;
  private mcpSharing = new DockerMcpSharing();
  private stopWorker?: () => Promise<void>;
  private stopObservation?: () => void;
  private closing = false;
  private epoch = randomUUID();
  /** Set before start() to serve the gateway behind the connection service. */
  listenOptions?: Parameters<Host["listen"]>[0];
  /** Launch facts owned by the CLI (connection, supervisor), merged into status. */
  statusExtras: () => object = () => ({});
  constructor(
    dir: string,
    options: Options,
    private execution: ExecutionLifecycle = new ExecutionProcess(),
  ) {
    if (!companionMode)
      throw new Error(
        "WorkspaceHost requires LOOP_PROFILE=companion before loading the application",
      );
    // Identity survives URL changes and application restarts. This does not
    // create fleet membership or grant peer access. The separate enrollment
    // protocol below verifies destination consent before installing a binding.
    if (!preview) this.fleet = new FleetAuthority(db, { seal, unseal });
    if (this.fleet) this.pairing = new FleetPairing(db, this.fleet, OWNER, dir);
    if (this.fleet) {
      this.fleetReconcile = new FleetDirectoryReconcile(
        db,
        this.fleet,
        OWNER,
        { seal, unseal },
        new FleetDirectoryHttpTransport(),
      );
      this.fleetCredentials = new FleetCredentials(db, this.fleet, {
        seal,
        unseal,
      });
      this.fleetLeases = new FleetCredentialLeases(
        this.fleet,
        this.fleetCredentials,
        OWNER,
        new FleetCredentialHttpTransport(),
        undefined,
        { reconcile: () => this.fleetReconcile!.any() },
      );
    }
    this.gateway = new Host(
      dir,
      {
        harness: options.harness,
        project: options.project,
        version: options.version,
        billing: { mode: options.billing, description: "Workspace host" },
        capabilities: {
          approvals: true,
          questions: true,
          resume: true,
          liveAttach: false,
          terminal: false,
        },
      },
      this.pairing,
    );
    if (this.fleet && this.pairing)
      this.enrollment = new FleetEnrollmentDestination(
        db,
        this.fleet,
        this.pairing,
        OWNER,
        { seal, unseal },
        () => this.gateway.origin,
      );
    if (this.fleet && this.pairing && this.enrollment) {
      const source = new FleetEnrollmentSource(
        db,
        this.fleet,
        OWNER,
        { seal, unseal },
        new FleetEnrollmentHttpTransport(),
      );
      this.fleetAdmin = new FleetLocalAdmin(
        db,
        this.fleet,
        this.pairing,
        source,
        this.enrollment,
        new FleetHandoffSource(
          db,
          this.fleet,
          OWNER,
          { seal, unseal },
          new FleetHandoffHttpTransport(),
        ),
        OWNER,
        () => this.gateway.origin,
      );
    }
    if (this.fleet)
      this.fleetDistribution = new FleetDistribution(
        db,
        this.fleet,
        OWNER,
        { seal, unseal },
        new FleetDirectoryHttpTransport(),
        undefined,
        { reconcile: this.fleetReconcile },
      );
    if (this.fleet && this.fleetCredentials && this.fleetLeases)
      this.fleetWorkspace = new FleetWorkspaceServices(
        db,
        this.fleet,
        this.fleetCredentials,
        this.fleetLeases,
        OWNER,
        { seal, unseal },
        app,
        uploadFile,
      );
    this.gateway.workspace = {
      isolated: !!preview,
      http: app,
      sources: this.fleetWorkspace
        ? new AgentSources([dockerSourceAdapter, this.fleetWorkspace.source])
        : undefined,
      fleetCommandsHttp:
        this.fleetWorkspace && this.pairing
          ? createFleetCommandsHttp(
              this.pairing,
              this.fleetWorkspace.actions,
              this.fleetWorkspace.workspaceActions,
              this.fleetWorkspace.uploads,
              this.fleetWorkspace.workspaceUploads,
            )
          : undefined,
      fleetAdminHttp: this.fleetAdmin
        ? createFleetAdminHttp(this.fleetAdmin)
        : undefined,
      peerHttp: this.enrollment
        ? createFleetPeerHttp(this.enrollment, () => this.gateway.origin, {
            credentials: this.fleetCredentials,
            workspaceRead: this.fleetWorkspace?.workspaceRead,
            workspaceActions: this.fleetWorkspace?.workspaceActions,
            workspaceFiles: this.fleetWorkspace?.workspaceFiles,
            workspaceUploads: this.fleetWorkspace?.workspaceUploads,
            pendingDirectory: new FleetPendingDirectory(
              db,
              this.fleet!,
              this.enrollment,
              OWNER,
              { seal, unseal },
            ),
            directory: new FleetDirectorySync(db, this.fleet!, OWNER, {
              seal,
              unseal,
            }),
            handoff: new FleetHandoffDestination(db, this.fleet!, OWNER, {
              seal,
              unseal,
            }),
          })
        : undefined,
      authorizeToken: authorizeIntegrationToken,
      tokenEvents: createTokenEventSockets(authorizeIntegrationToken),
      status: () => ({
        workspace: true,
        state: "ready",
        project: options.project,
        serverReady: true,
        executionReady:
          executionClient.connected &&
          !!db
            .prepare(
              "SELECT 1 FROM connections WHERE owner_id=? AND status='connected' AND json_extract(metadata,'$.loopHarness') IS NOT NULL",
            )
            .get(OWNER),
        harnesses: nativeSessions.registrations(),
        activeRuns: designPreview
          ? { n: 0 }
          : db
              .prepare(
                "SELECT count(*) n FROM runs WHERE state IN ('running','pausing','awaiting_approval')",
              )
              .get(),
        agents: (db.prepare("SELECT count(*) n FROM agents").get() as any).n,
        build: BUILD,
        buildIdentity: publicBuild(observedBuild()),
        ...this.statusExtras(),
      }),
      admin: async (action, input) => {
        if (designPreview)
          throw new Error("Design previews do not enable native harnesses.");
        if (action === "/enable")
          return executionRequest("runtime.register", {
            options: RegistrationOptions.parse(input),
          });
        throw new Error("Unknown workspace control command");
      },
      shareTools: (sourceId, action) =>
        sourceId
          ? action === "disconnect"
            ? this.mcpSharing.disconnect(sourceId)
            : this.mcpSharing.connect(sourceId)
          : this.mcpSharing.status(),
      originChanged: (origin) => {
        config.url = origin;
        this.execution.setOrigin?.(origin);
      },
      connect: (socket, url) =>
        connectWorkspaceEvents(socket, url, OWNER, this.epoch, BUILD),
    };
  }
  get port() {
    return this.gateway.port;
  }
  get origin() {
    return this.gateway.origin;
  }
  pair() {
    return this.gateway.pair();
  }
  setOrigin(origin: string) {
    this.gateway.setOrigin(origin);
  }
  async start(
    options: Options,
    beforeWorker?: () => Promise<void>,
    prepare?: () => Promise<any>,
    runtimeNeutral = false,
    onListening?: () => Promise<void>,
  ) {
    if (this.closing) throw new Error("Workspace is stopping");
    if (designPreview) {
      const { seedDesignPreview, startDesignSimulation } =
        await import("./server/design-preview.js");
      seedDesignPreview();
      this.stopWorker = startDesignSimulation();
      await this.gateway.listen(this.listenOptions);
      if (this.closing) {
        await this.gateway.close();
        throw new Error("Workspace is stopping");
      }
      this.stopObservation = observeProcess("api");
      await onListening?.();
      return {
        billing: {
          description:
            "Design preview: sample data and simulated replies; no provider execution.",
        },
      };
    }
    await this.execution.open();
    if (this.closing) {
      await this.execution.close();
      throw new Error("Workspace is stopping");
    }
    await this.gateway.listen(this.listenOptions);
    if (this.closing) {
      await this.gateway.close();
      throw new Error("Workspace is stopping");
    }
    this.stopObservation = observeProcess("api");
    if (!preview) {
      this.mcpSharing.start();
      this.fleetDistribution?.start();
    }
    // Pairing and the public gateway can be made available before runner startup.
    // Register the project first so a paired client can inspect its workspace.
    nativeSessions.addProject(options.project);
    await onListening?.();
    if (this.closing) throw new Error("Workspace is stopping");
    const account =
      (await prepare?.()) ??
      // A neutral launch discovers each harness independently.
      (runtimeNeutral || prepare
        ? (nativeSessions.addProject(options.project),
          {
            billing: {
              description:
                "Execution host ready. Choose and enable an installed runtime in the app; authentication is checked when enabling.",
            },
          })
        : await executionRequest("runtime.register", {
            options: {
              harness: options.harness,
              executable: options.executable,
              project: options.project,
              version: options.version,
              billing: options.billing,
              args: options.args,
            },
          }));
    await beforeWorker?.();
    if (this.closing) throw new Error("Workspace is stopping");
    await this.execution.schedule();
    return account;
  }
  async close() {
    this.closing = true;
    this.fleetDistribution?.close();
    this.fleetWorkspace?.close();
    this.fleetLeases?.close();
    this.fleetReconcile?.close();
    this.stopObservation?.();
    this.mcpSharing.close();
    try {
      await this.stopWorker?.();
      if (!designPreview) await this.execution.close();
    } finally {
      await this.gateway.close();
    }
  }
}
