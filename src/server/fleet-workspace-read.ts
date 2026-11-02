import * as profileQueries from "./sql/deployment-profile.js";
import type Database from "better-sqlite3";
import {
  FleetReadRequest,
  FleetReadResponse,
  FleetWorkspaceCatalog,
  fleetReadRoutes,
  fleetWorkspaceApi,
} from "../shared/fleet-workspace-api.js";
import { FleetProof } from "./fleet-proof.js";
import { directoryDigest, fleetPayloadDigest } from "./fleet-crypto.js";
import { Problem } from "../shared/problem.js";
import type { FleetAuthority } from "./fleet-authority.js";
import type { FleetCredentials } from "./fleet-credentials.js";
import type { FleetWorkspaceApp } from "./fleet-workspace-app.js";

/** Owner-scoped local projections only. An enrolled peer's credential maps to
 * this destination's owner; an input never supplies an owner, path or source. */
export class FleetWorkspaceRead {
  private readonly proof: FleetProof;
  private pending = 0;
  private stopped = false;
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly credentials: FleetCredentials,
    private readonly owner: string,
    private readonly app: FleetWorkspaceApp,
    secrets: ConstructorParameters<typeof FleetProof>[2],
    private readonly options: {
      actions?: () => readonly string[];
      files?: boolean;
      uploads?: boolean;
      events?: boolean;
    } = {},
  ) {
    this.proof = new FleetProof(db, authority.identity, secrets);
  }
  private authorize(credential: string, catalog = false) {
    if (
      this.stopped ||
      (profileQueries.current(this.db) as { profile: string } | undefined)
        ?.profile !== "companion"
    )
      throw new Problem(403, "This workspace does not admit fleet reads.");
    const accepted = this.credentials.authenticate(credential);
    if (
      accepted.owner !== this.owner ||
      (accepted.context.operation !== "read" &&
        !(
          catalog &&
          ["act", "files", "events"].includes(accepted.context.operation)
        ))
    )
      throw new Problem(
        403,
        "This credential cannot read the local workspace.",
      );
    const directory = this.authority.directory(this.owner);
    if (!directory)
      throw new Problem(403, "The fleet directory is unavailable.");
    return {
      directory: directoryDigest(directory.document),
      context: accepted.context,
    };
  }
  catalog(input: unknown) {
    const request = fleetWorkspaceApi.catalog.body.parse(input);
    const authorization = this.authorize(request.credential, true);
    const allowed = (operation: "read" | "act" | "files" | "events") => {
      try {
        this.authority.acceptedGrant(
          this.owner,
          authorization.context.peer,
          authorization.context.fleetId,
          authorization.context.grantId,
          operation,
        );
        return true;
      } catch (error) {
        if (error instanceof Problem && error.status === 403) return false;
        throw error;
      }
    };
    const catalog = FleetWorkspaceCatalog.parse({
      version: 1,
      requestId: request.requestId,
      machineId: this.authority.identity.machineId,
      directory: authorization.directory,
      peer: authorization.context.peer,
      grantId: authorization.context.grantId,
      requestDigest: fleetPayloadDigest({ requestId: request.requestId }),
      profile: "companion",
      reads: allowed("read") ? Object.keys(fleetReadRoutes) : [],
      actions: [
        ...(allowed("act") ? (this.options.actions?.() ?? []) : []),
        ...(this.options.uploads && allowed("files") ? ["uploadCreate"] : []),
      ],
      events: !!this.options.events && allowed("events"),
      files: !!this.options.files && allowed("files"),
    });
    return {
      catalog,
      signature: this.proof.sign("workspace-catalog", catalog),
    };
  }
  async read(input: unknown) {
    const request = FleetReadRequest.parse(input);
    const authorization = this.authorize(request.credential);
    if (this.pending >= 4)
      throw new Problem(503, "The remote workspace is busy. Retry later.");
    this.pending++;
    const authorize = () => {
      if (
        this.authorize(request.credential).directory !== authorization.directory
      )
        throw new Problem(409, "The fleet directory changed during this read.");
    };
    try {
      const output = await this.app.read(this.owner, request.input, authorize);
      authorize();
      const response = FleetReadResponse.safeParse({
        version: 1,
        requestId: request.requestId,
        machineId: this.authority.identity.machineId,
        directory: authorization.directory,
        peer: authorization.context.peer,
        grantId: authorization.context.grantId,
        requestDigest: fleetPayloadDigest({
          requestId: request.requestId,
          input: request.input,
        }),
        ...output,
      });
      if (!response.success)
        throw new Problem(
          502,
          "The remote workspace response exceeds its projection limits.",
        );
      return {
        response: response.data,
        signature: this.proof.sign("workspace-read", response.data),
      };
    } finally {
      this.pending--;
    }
  }
  close() {
    this.stopped = true;
  }
}
