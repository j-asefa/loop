import { join } from "node:path";
import { HarnessUpgrades } from "../harness-upgrades.js";
import { config } from "./config.js";
export const harnessUpgrades = new HarnessUpgrades(
  join(config.data, "harness-upgrades.json"),
);
