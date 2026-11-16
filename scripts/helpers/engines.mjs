import { chromium, webkit } from "@playwright/test";

export function selectedEngines() {
  const engines = { chromium, webkit };
  const selected = process.env.LOOP_BROWSER;
  if (!selected) return [chromium, webkit];
  if (!engines[selected]) throw new Error(`Unknown LOOP_BROWSER: ${selected}`);
  return [engines[selected]];
}
