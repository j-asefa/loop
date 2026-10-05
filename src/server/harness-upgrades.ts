import { join } from "node:path";
import { HarnessUpgrades } from "../harness-upgrades.js";
import { config } from "./config.js";
export const harnessUpgrades = new HarnessUpgrades(
  join(config.data, "harness-upgrades.json"),
);
// Execution-environment runtimes ("hostId:flavor") with an upgrade request in
// flight to their runner. Held from before the active-run check until the
// runner has recorded the upgrade, after which the runner refuses sessions.
export const environmentUpgrades = new Set<string>();
