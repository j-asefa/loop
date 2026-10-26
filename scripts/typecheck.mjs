// TypeScript shares admission with builds, tests and browser smokes.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { watchRequested, withHeavySlot } from "./heavy-command.mjs";
export { SLOT_BUSY_EXIT, privateLockDir } from "./heavy-command.mjs";
export function withTypecheckSlot(command, args, options = {}) {
  return withHeavySlot(command, args, { label: "typecheck", ...options });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // The package does not export its bin path; walk up from the library entry
  // to the package's own manifest rather than assuming a layout.
  let root = dirname(createRequire(import.meta.url).resolve("typescript"));
  let manifest;
  for (;;) {
    try {
      manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      if (manifest.name === "typescript") break;
    } catch {}
    if (dirname(root) === root)
      throw new Error("The typescript package manifest was not found.");
    root = dirname(root);
  }
  const bin =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.tsc;
  if (!bin) throw new Error("The typescript package declares no tsc binary.");
  const args = [join(root, bin), "--noEmit", ...process.argv.slice(2)];
  // Watch mode would hold the slot for a whole session; it runs outside it.
  const watch = watchRequested(process.argv.slice(2));
  process.exitCode = await withHeavySlot(process.execPath, args, {
    label: "typecheck",
    schedule: !watch,
  });
}
