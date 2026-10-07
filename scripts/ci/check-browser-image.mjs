import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { chromium, webkit } from "@playwright/test";
import { browserImage } from "./changes.mjs";
assert.equal(process.versions.node.split(".")[0], "24", "CI must run Node 24");
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
console.log(`Expected browser image: ${browserImage(lock)}`);
for (const browser of [chromium, webkit]) {
  assert(
    existsSync(browser.executablePath()),
    `Missing locked ${browser.name()} executable`,
  );
  const instance = await browser.launch({ headless: true });
  console.log(`${browser.name()}: ${instance.version()}`);
  await instance.close();
}
