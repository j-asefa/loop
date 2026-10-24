import { join } from "node:path";
import { HarnessUpgrades } from "../harness-upgrades.js";
import { config } from "./config.js";
let instance: HarnessUpgrades | undefined;
// API-side filesystem helpers import NativeSessions too. Importing them must
// not reconcile upgrade records or launch version probes before worker lock
// acquisition. The execution authority initializes this singleton explicitly.
export const harnessUpgrades = new Proxy({} as HarnessUpgrades, {
  get(_target, property) {
    instance ??= new HarnessUpgrades(join(config.data, "harness-upgrades.json"));
    const value = Reflect.get(instance, property, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
