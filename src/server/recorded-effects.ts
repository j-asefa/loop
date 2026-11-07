import type Database from "better-sqlite3";
import * as recordedQueries from "./sql/fleet-effect-authorizations.js";
import { ExecutionRefused } from "./execution-refusal.js";
import {
  delegatedActionInProgress,
  type EffectAuthority,
  type EffectKind,
} from "./effect-authority.js";

/** Without --fleet, an effect a peer authorized earlier keeps its constraints
 * by never running: it is refused, not delivered as local work. Local effects
 * record nothing and proceed. */
export function refuseRecordedEffects(db: Database.Database): EffectAuthority {
  const refuse = (owner: string, kind: EffectKind, effectId: string) => {
    if (recordedQueries.firstCommand(db, { owner, kind, effectId }))
      throw new ExecutionRefused(
        403,
        "This work was authorized through a fleet. Restart Loop with loop start --fleet to run it.",
      );
  };
  const local = () => {
    if (delegatedActionInProgress())
      throw new ExecutionRefused(
        403,
        "Delegated actions are unavailable on this machine.",
      );
  };
  return {
    authorize: () => {
      throw new ExecutionRefused(
        403,
        "Delegated actions are unavailable on this machine.",
      );
    },
    discardEdit: () => {
      throw new ExecutionRefused(
        403,
        "Delegated edit recovery requires loop start --fleet.",
      );
    },
    record: () => local(),
    recordEdit: () => {
      local();
      return undefined;
    },
    assert: refuse,
    inherit: (owner, kind, effectId) => refuse(owner, kind, effectId),
    within: (owner, kind, effectId, apply) => {
      refuse(owner, kind, effectId);
      return apply();
    },
  };
}
