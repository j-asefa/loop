import { ExecutionRefused } from "./execution-refusal.js";

// The feed authorizes its durable effects through this one interface, without
// importing the extension that may constrain them. It imports no database, so
// loading it never opens one. Callers keep each call
// inside their owning transaction, so any record an implementation writes
// commits atomically with the effect it authorizes.
export type EffectKind = "run" | "steering" | "scheduled";
export type EffectEdit = Readonly<{
  owner: string;
  kind: EffectKind;
  effectId: string;
  commandId: string;
}>;
export type EffectAuthority = {
  /** Record the delegated authority that creates an effect. */
  record(owner: string, kind: EffectKind, effectId: string): void;
  /** Record the delegated authority that edits or retries an effect. */
  recordEdit(
    owner: string,
    kind: EffectKind,
    effectId: string,
  ): EffectEdit | undefined;
  /** Refuse an effect whose recorded authority no longer holds. */
  assert(owner: string, kind: EffectKind, effectId: string): void;
  /** Give dependent work every constraint of the effect it came from. */
  inherit(
    owner: string,
    kind: EffectKind,
    effectId: string,
    targetId: string,
    targetKind: EffectKind,
  ): void;
  /** Run work under the effect's recorded authority. */
  within<T>(
    owner: string,
    kind: EffectKind,
    effectId: string,
    apply: () => T,
  ): T;
};

let registered: EffectAuthority | undefined;
let delegated: () => boolean = () => false;

export function registerEffectAuthority(implementation: EffectAuthority) {
  registered = implementation;
}

/** Tests only: return to the unregistered, local-only state. */
export function resetEffectAuthorityForTests() {
  registered = undefined;
}

/** A module that runs delegated actions reports whether one is in progress.
 * Without an implementation to record it, such an action is refused. */
export function registerDelegatedActionProbe(probe: () => boolean) {
  delegated = probe;
}

/** The implementation in effect, if any. */
export function registeredEffectAuthority() {
  return registered;
}

export function delegatedActionInProgress() {
  return delegated();
}

function authority() {
  if (registered) return registered;
  if (delegated())
    throw new ExecutionRefused(
      403,
      "Delegated actions are unavailable on this machine.",
    );
  return undefined;
}

export function recordEffect(
  owner: string,
  kind: EffectKind,
  effectId: string,
) {
  authority()?.record(owner, kind, effectId);
}

export function recordEffectEdit(
  owner: string,
  kind: EffectKind,
  effectId: string,
): EffectEdit | undefined {
  return authority()?.recordEdit(owner, kind, effectId);
}

export function assertEffect(
  owner: string,
  kind: EffectKind,
  effectId: string,
) {
  authority()?.assert(owner, kind, effectId);
}

export function inheritEffect(
  owner: string,
  kind: EffectKind,
  effectId: string,
  targetId: string,
  targetKind: EffectKind = "run",
) {
  authority()?.inherit(owner, kind, effectId, targetId, targetKind);
}

export function withEffect<T>(
  owner: string,
  kind: EffectKind,
  effectId: string,
  apply: () => T,
): T {
  const implementation = authority();
  return implementation
    ? implementation.within(owner, kind, effectId, apply)
    : apply();
}
