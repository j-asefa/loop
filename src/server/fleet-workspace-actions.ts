import type Database from "better-sqlite3";
import { z } from "zod";
import {
  FleetActionInput,
  FleetActionRequest,
  FleetActionResponse,
  FleetActionReference,
  fleetActionRoutes,
  fleetWorkspaceActionApi,
} from "../shared/fleet-workspace-action-api.js";
import { Problem } from "../shared/problem.js";
import type { FleetAuthority } from "./fleet-authority.js";
import type { FleetCredentials } from "./fleet-credentials.js";
import type { FleetWorkspaceApp } from "./fleet-workspace-app.js";
import { FleetCommands, type FleetCommandReceipt } from "./fleet-commands.js";
import { FleetProof } from "./fleet-proof.js";
import { directoryDigest, fleetPayloadDigest } from "./fleet-crypto.js";
import { withFleetAction } from "./fleet-action-context.js";
import { ExecutionRefused } from "./execution-refusal.js";
import type { FleetGrantContext } from "../shared/fleet.js";

export { fleetActionInput } from "../shared/fleet-action-input.js";
import { fleetActionInput } from "../shared/fleet-action-input.js";

/** Machine credentials reach only declared local handlers, with their original
 * command ID. The destination stores a receipt before any handler or native IO.
 * Unknown outcomes can only be queried; this service never replays an effect. */
export class FleetWorkspaceActions {
  private readonly proof: FleetProof;
  private readonly commands: FleetCommands;
  private stopped = false;
  constructor(
    private readonly db: Database.Database,
    private readonly authority: FleetAuthority,
    private readonly credentials: FleetCredentials,
    private readonly owner: string,
    private readonly app: FleetWorkspaceApp,
    secrets: ConstructorParameters<typeof FleetProof>[2],
  ) {
    this.proof = new FleetProof(db, authority.identity, secrets);
    this.commands = new FleetCommands(db, authority, { limit: 4, status: 503 });
  }
  private active() {
    if (
      this.stopped ||
      (
        this.db
          .prepare("SELECT profile FROM deployment_profile WHERE singleton=1")
          .get() as { profile: string } | undefined
      )?.profile !== "companion"
    )
      throw new ExecutionRefused(
        403,
        "This workspace does not admit fleet actions.",
      );
  }
  private authorize(credential: string) {
    this.active();
    try {
      const accepted = this.credentials.authenticate(credential);
      if (accepted.owner !== this.owner || accepted.context.operation !== "act")
        throw new Error("Wrong owner or operation");
      return accepted.context;
    } catch {
      throw new ExecutionRefused(
        403,
        "This credential cannot act on the local workspace.",
      );
    }
  }
  private accepted(context: FleetGrantContext) {
    this.active();
    // Credential admission commits its expiry observations before acceptance.
    // Owning handlers may now be inside their synchronous write transaction:
    // recheck the accepted grant there, without nesting credential-clock writes
    // that could be rolled back with an unrelated application failure.
    try {
      this.authority.acceptedGrant(
        this.owner,
        context.peer,
        context.fleetId,
        context.grantId,
        context.operation,
      );
    } catch {
      throw new ExecutionRefused(
        403,
        "The fleet grant no longer permits this action.",
      );
    }
  }
  private ownedReferences(owner: string, input: FleetActionInput) {
    const record =
      input.body && typeof input.body === "object" && !Array.isArray(input.body)
        ? (input.body as Record<string, unknown>)
        : {};
    const own = (
      table: "agents" | "runs" | "conversations" | "approvals" | "folders",
      id: unknown,
    ) => {
      if (id === undefined) return;
      if (
        typeof id !== "string" ||
        !this.db
          .prepare(`SELECT 1 FROM ${table} WHERE id=? AND owner_id=?`)
          .get(id, owner)
      )
        throw new ExecutionRefused(404, "The workspace item is unavailable.");
    };
    if (input.route === "agentUpdate") own("agents", input.params.id);
    if (["folderUpdate", "workspaceProjectUpdate"].includes(input.route))
      own("folders", input.params.id);
    if (
      [
        "runAction",
        "runReorder",
        "runUpdate",
        "runWithdraw",
        "runMove",
      ].includes(input.route)
    )
      own("runs", input.params.id);
    if (
      [
        "setting",
        "conversationPosition",
        "conversationFork",
        "conversationContinue",
        "conversationContinueStart",
      ].includes(input.route)
    )
      own("conversations", input.params.id);
    if (input.route === "approval") own("approvals", input.params.id);
    if (
      [
        "submit",
        "scheduledSendCreate",
        "runMove",
        "conversationFork",
        "conversationContinue",
        "conversationContinueStart",
      ].includes(input.route)
    )
      own("agents", record.agentId);
    if (["submit", "scheduledSendCreate"].includes(input.route))
      own("conversations", record.conversationId);
    if (
      input.route === "nativeAnswer" &&
      !this.db
        .prepare(
          "SELECT 1 FROM native_decisions d JOIN runs r ON r.id=d.run_id WHERE d.id=? AND r.owner_id=?",
        )
        .get(input.params.id, owner)
    )
      throw new ExecutionRefused(404, "The workspace decision is unavailable.");
  }
  private signed(
    request: Pick<FleetActionRequest, "requestId" | "commandId" | "credential">,
    receipt: FleetCommandReceipt | null,
    requestDigest: string,
  ) {
    const context = this.authorize(request.credential);
    const directory = this.authority.directory(this.owner);
    if (!directory)
      throw new Problem(403, "The fleet directory is unavailable.");
    const response = FleetActionResponse.parse({
      version: 1,
      requestId: request.requestId,
      machineId: this.authority.identity.machineId,
      peer: context.peer,
      directory: directoryDigest(directory.document),
      grantId: context.grantId,
      requestDigest,
      receipt,
    });
    return {
      response,
      signature: this.proof.sign("workspace-action", response),
    };
  }
  async action(input: unknown) {
    const request = FleetActionRequest.parse(input);
    const context = this.authorize(request.credential);
    const value = fleetActionInput(request.input, request.commandId);
    const receipt = await this.commands.execute(
      context,
      request.commandId,
      // Receipts bind the parsed wire payload, before handler defaults or
      // inner command identities are supplied. The caller can hash it too.
      request.input,
      fleetActionRoutes[value.route].response,
      (owner, commandId) =>
        withFleetAction(
          { owner, commandId, grant: context },
          () => this.accepted(context),
          async () => {
            this.ownedReferences(owner, value);
            return (
              await this.app.action(owner, value, () => this.accepted(context))
            ).result;
          },
        ),
      value.route,
    );
    return this.signed(
      request,
      receipt,
      fleetPayloadDigest({
        requestId: request.requestId,
        commandId: request.commandId,
        input: request.input,
      }),
    );
  }
  receipt(input: unknown) {
    const request = fleetWorkspaceActionApi.receipt.body.parse(input);
    const context = this.authorize(request.credential);
    const receipt = request.route
      ? this.commands.reconcile(
          context,
          request.commandId,
          request.payloadDigest,
          request.route,
        )
      : this.commands.receipt(
          context,
          request.commandId,
          request.payloadDigest,
        );
    return this.signed(
      request,
      receipt,
      fleetPayloadDigest({
        requestId: request.requestId,
        commandId: request.commandId,
        payloadDigest: request.payloadDigest,
        ...(request.route ? { route: request.route } : {}),
      }),
    );
  }
  get machineId() {
    return this.authority.identity.machineId;
  }
  localReceipt(commandId: string, reference: FleetActionReference) {
    this.active();
    const value = FleetActionReference.parse(reference);
    const receipt = this.commands.localReceipt(
      this.owner,
      commandId,
      value.payloadDigest,
      value.route,
    );
    return receipt
      ? {
          ...receipt,
          result:
            receipt.result === null
              ? null
              : fleetActionRoutes[value.route].response.parse(receipt.result),
        }
      : { commandId, state: "unknown" as const, result: null };
  }
  close() {
    this.stopped = true;
  }
}
