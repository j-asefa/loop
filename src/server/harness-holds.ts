import { ExecutionRefused } from "./execution-refusal.js";
import { harnessUpgrades } from "./harness-upgrades.js";
import { nativeSignIns } from "./native-auth.js";

type HoldReason = "upgrade" | "provider-change" | "sign-in";

class HarnessHolds {
  private providerChanges = new Set<string>();
  // Read lifecycle state at the guard, including persisted upgrade recovery.
  // Mirroring it here could release a harness before recovery is confirmed.
  private sources: Record<HoldReason, (name: string) => boolean> = {
    upgrade: (name) => harnessUpgrades.busy(name),
    "provider-change": (name) => this.providerChanges.has(name),
    "sign-in": (name) => nativeSignIns.inProgress(name),
  };

  first(
    name: string,
    reasons: readonly HoldReason[] = Object.keys(this.sources) as HoldReason[],
  ): HoldReason | undefined {
    return reasons.find((reason) => this.sources[reason](name));
  }

  reserveProviderChange(name: string) {
    if (this.providerChanges.has(name))
      throw new ExecutionRefused(
        409,
        "A provider change is already in progress. Check its status before trying again.",
      );
    this.providerChanges.add(name);
    return () => {
      this.providerChanges.delete(name);
    };
  }
}

export const harnessHolds = new HarnessHolds();
