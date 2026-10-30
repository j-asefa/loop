import "../../deployment/environment.mjs";
import { chromium, webkit } from "@playwright/test";

// CI runs each engine in its own job; unset keeps both for local runs.
export function selectedEngines() {
  const engines = { chromium, webkit };
  const selected = process.env.LOOP55_BROWSER;
  if (!selected) return [chromium, webkit];
  if (!engines[selected])
    throw new Error(`Unknown LOOP55_BROWSER: ${selected}`);
  return [engines[selected]];
}
