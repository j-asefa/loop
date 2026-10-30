import type Database from "better-sqlite3";
import type { FleetAuthority } from "./fleet-authority.js";
import type { FleetCredentials } from "./fleet-credentials.js";
import type { FleetCredentialLeases } from "./fleet-credential-leases.js";
import type { uploadFile } from "./uploads.js";
import { fleetActionRoutes } from "../shared/fleet-workspace-action-api.js";
import { FleetWorkspaceApp } from "./fleet-workspace-app.js";
import { FleetWorkspaceRead } from "./fleet-workspace-read.js";
import { FleetWorkspaceActions } from "./fleet-workspace-actions.js";
import { FleetWorkspaceFiles } from "./fleet-workspace-files.js";
import { FleetWorkspaceUploads } from "./fleet-workspace-uploads.js";
import { FleetPeerReads } from "./fleet-peer-reads.js";
import { FleetPeerActions } from "./fleet-peer-actions.js";
import { FleetPeerFiles } from "./fleet-peer-files.js";
import { FleetPeerUploads } from "./fleet-peer-uploads.js";
import { FleetWorkspaceHttpTransport } from "./fleet-workspace-http.js";
import { FleetWorkspaceActionHttpTransport } from "./fleet-workspace-action-http.js";
import { FleetWorkspaceFileHttpTransport } from "./fleet-workspace-file-http.js";
import { FleetWorkspaceUploadHttpTransport } from "./fleet-workspace-upload-http.js";
import { fleetAgentSource } from "./fleet-agent-source.js";

/** One companion's owner-bound services. Opening a workspace installs no peer
 * grants and starts no workspace polling; traffic requires a verified member,
 * the matching scope and an authenticated local device or machine request. */
export class FleetWorkspaceServices {
  readonly workspaceRead: FleetWorkspaceRead;
  readonly workspaceActions: FleetWorkspaceActions;
  readonly workspaceFiles: FleetWorkspaceFiles;
  readonly workspaceUploads: FleetWorkspaceUploads;
  readonly reads: FleetPeerReads;
  readonly actions: FleetPeerActions;
  readonly files: FleetPeerFiles;
  readonly uploads: FleetPeerUploads;
  readonly source: ReturnType<typeof fleetAgentSource>;

  constructor(
    db: Database.Database,
    authority: FleetAuthority,
    credentials: FleetCredentials,
    leases: FleetCredentialLeases,
    owner: string,
    secrets: ConstructorParameters<typeof FleetWorkspaceRead>[5],
    app: ConstructorParameters<typeof FleetWorkspaceApp>[0],
    applyUpload: typeof uploadFile,
  ) {
    const bridge = new FleetWorkspaceApp(app, owner);
    this.workspaceActions = new FleetWorkspaceActions(
      db,
      authority,
      credentials,
      owner,
      bridge,
      secrets,
    );
    this.workspaceFiles = new FleetWorkspaceFiles(
      db,
      authority,
      credentials,
      owner,
      bridge,
      secrets,
    );
    this.workspaceUploads = new FleetWorkspaceUploads(
      db,
      authority,
      credentials,
      owner,
      secrets,
      applyUpload,
    );
    this.workspaceRead = new FleetWorkspaceRead(
      db,
      authority,
      credentials,
      owner,
      bridge,
      secrets,
      {
        actions: () => Object.keys(fleetActionRoutes),
        files: true,
        uploads: true,
      },
    );
    this.reads = new FleetPeerReads(
      authority,
      leases,
      owner,
      new FleetWorkspaceHttpTransport(),
    );
    this.actions = new FleetPeerActions(
      db,
      authority,
      leases,
      owner,
      new FleetWorkspaceActionHttpTransport(),
    );
    this.files = new FleetPeerFiles(
      authority,
      leases,
      owner,
      new FleetWorkspaceFileHttpTransport(),
    );
    this.uploads = new FleetPeerUploads(
      db,
      authority,
      leases,
      owner,
      new FleetWorkspaceUploadHttpTransport(),
    );
    this.source = fleetAgentSource(
      authority,
      owner,
      this.reads,
      this.actions,
      this.files,
      this.uploads,
    );
  }

  close() {
    this.reads.close();
    this.actions.close();
    this.files.close();
    this.uploads.close();
    this.workspaceRead.close();
    this.workspaceActions.close();
    this.workspaceFiles.close();
    this.workspaceUploads.close();
  }
}
