import * as fleetEffectAuthorizationsQueries from "./sql/fleet-effect-authorizations.js";
import * as fleetEffectEditAuthorizationsQueries from "./sql/fleet-effect-edit-authorizations.js";
import { FleetGrantContext } from "../shared/fleet.js";
import { db } from "./db.js";
import { FleetAuthority } from "./fleet-authority.js";
import { seal, unseal } from "./secrets.js";
import { ExecutionRefused } from "./execution-refusal.js";
import {
  registerEffectAuthority,
  type EffectAuthority,
  type EffectKind,
} from "./effect-authority.js";
import { fleetPayloadDigest } from "./fleet-crypto.js";
import {
  currentFleetAction,
  withFleetAction,
  withoutFleetAction,
  assertFleetAction,
} from "./fleet-action-context.js";

type Kind = EffectKind;
type FleetEffectEdit = Readonly<{
  owner: string;
  kind: Kind;
  effectId: string;
  commandId: string;
}>;
let authority: FleetAuthority | undefined;

function insertEdit(
  owner: string,
  kind: Kind,
  effectId: string,
  commandId: string,
  grantContext: string,
) {
  const prior = fleetEffectAuthorizationsQueries.commandGrants(db, {
    owner,
    kind,
    effectId,
    commandId,
  }) as { grant_context: string }[];
  const digest = fleetPayloadDigest(JSON.parse(grantContext));
  if (
    prior.some(
      (row) => fleetPayloadDigest(JSON.parse(row.grant_context)) !== digest,
    )
  )
    throw new ExecutionRefused(
      409,
      "This effect command belongs to a different fleet grant.",
    );
  return fleetEffectEditAuthorizationsQueries.insert(
    db,
    owner,
    kind,
    effectId,
    commandId,
    grantContext,
  ).changes;
}

export function authorizeFleetEffect(owner: string, input: FleetGrantContext) {
  const grant = FleetGrantContext.parse(input);
  try {
    const local = (authority ??= new FleetAuthority(db, { seal, unseal }));
    if (grant.destination !== local.identity.machineId)
      throw new Error("Wrong destination");
    local.acceptedGrant(
      owner,
      grant.peer,
      grant.fleetId,
      grant.grantId,
      grant.operation,
    );
  } catch {
    throw new ExecutionRefused(
      403,
      "The fleet grant no longer permits this effect.",
    );
  }
}

/** Called inside the owning queue transaction, before acceptance. The native
 * run/steering identity remains unchanged. No credential is stored. */
export function recordFleetEffect(owner: string, kind: Kind, effectId: string) {
  const context = currentFleetAction();
  if (!context) return;
  if (!db.inTransaction || context.owner !== owner)
    throw new ExecutionRefused(
      403,
      "Fleet acceptance requires its owner transaction.",
    );
  authorizeFleetEffect(owner, context.grant);
  fleetEffectAuthorizationsQueries.insert(
    db,
    owner,
    kind,
    effectId,
    context.commandId,
    JSON.stringify(context.grant),
  );
}

/** An edit or explicit retry can introduce peer-controlled deferred work even
 * when a local device created the original. Retain both authorizations. */
export function recordFleetEffectEdit(
  owner: string,
  kind: Kind,
  effectId: string,
): FleetEffectEdit | undefined {
  const context = currentFleetAction();
  if (!context) return;
  if (!db.inTransaction || context.owner !== owner)
    throw new ExecutionRefused(
      403,
      "Fleet editing requires its owner transaction.",
    );
  authorizeFleetEffect(owner, context.grant);
  const added = insertEdit(
    owner,
    kind,
    effectId,
    context.commandId,
    JSON.stringify(context.grant),
  );
  if (added) return { owner, kind, effectId, commandId: context.commandId };
}

/** Only definitive non-delivery may discard the new attempt's constraint.
 * Join the decision's recovery transaction; never remove a pre-existing edit. */
export function discardFleetEffectEdit(edit: FleetEffectEdit | undefined) {
  if (!edit) return;
  if (!db.inTransaction)
    throw new Error("Fleet edit recovery requires its owner transaction.");
  fleetEffectEditAuthorizationsQueries.remove(
    db,
    edit.owner,
    edit.kind,
    edit.effectId,
    edit.commandId,
  );
}

/** Dependent work and its authorization share the owning transaction. Retain
 * every creator/editor constraint alongside the new command's grant. */
export function inheritFleetEffect(
  owner: string,
  kind: Kind,
  effectId: string,
  targetId: string,
  targetKind: Kind = "run",
) {
  if (!db.inTransaction)
    throw new ExecutionRefused(
      403,
      "Fleet inheritance requires its owner transaction.",
    );
  assertFleetAction(owner);
  assertFleetEffect(owner, kind, effectId);
  const rows = fleetEffectAuthorizationsQueries.commands(db, {
    owner,
    kind,
    effectId,
  }) as {
    command_id: string;
    grant_context: string;
  }[];
  for (const row of rows)
    insertEdit(owner, targetKind, targetId, row.command_id, row.grant_context);
}

/** Revalidate queued work after restart and immediately before native IO.
 * Address revisions may retain the approved grant; tombstones and resets cannot. */
export function assertFleetEffect(owner: string, kind: Kind, effectId: string) {
  const rows = fleetEffectAuthorizationsQueries.grants(db, {
    owner,
    kind,
    effectId,
  }) as { grant_context: string }[];
  for (const row of rows)
    authorizeFleetEffect(
      owner,
      FleetGrantContext.parse(JSON.parse(row.grant_context)),
    );
}

export function withFleetEffect<T>(
  owner: string,
  kind: Kind,
  effectId: string,
  apply: () => T,
): T {
  assertFleetEffect(owner, kind, effectId);
  const row = fleetEffectAuthorizationsQueries.firstCommand(db, {
    owner,
    kind,
    effectId,
  }) as { command_id: string; grant_context: string } | undefined;
  if (!row) return withoutFleetAction(apply);
  const grant = FleetGrantContext.parse(JSON.parse(row.grant_context));
  // Either table supplies a durable context, including inherited constraints.
  // Every late check still validates all contributors, not just this row.
  return withFleetAction(
    { owner, commandId: row.command_id, grant },
    () => assertFleetEffect(owner, kind, effectId),
    apply,
  );
}

/** The feed reaches these checks only through effect-authority.ts. */
export const fleetEffectAuthority: EffectAuthority = {
  record: recordFleetEffect,
  recordEdit: recordFleetEffectEdit,
  assert: assertFleetEffect,
  inherit: inheritFleetEffect,
  within: withFleetEffect,
};
// Core modules still import these checks directly, so loading this module
// keeps the feed on the same authority as they are.
registerEffectAuthority(fleetEffectAuthority);
