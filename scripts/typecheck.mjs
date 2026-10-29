// Run TypeScript with the same descendant cleanup as other repository checks.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { runSupervised } from "./heavy-command.mjs";
import { checkOptions } from "../deployment/job-shim.mjs";
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
  // TypeScript 7's parallel checkers duplicate large type graphs. Keep full
  // checking while reducing peak RAM; Go's soft heap target is not a hard cap.
  const args = [
    join(root, bin),
    "--noEmit",
    "--singleThreaded",
    ...process.argv.slice(2),
  ];
  process.exitCode = await runSupervised(process.execPath, args, {
    label: "typecheck",
    job: !checkOptions(process.argv.slice(2)).some(
      (arg) => arg === "-w" || /^--watch(?:=true)?$/.test(arg),
    ),
    env: {
      ...process.env,
      GOMEMLIMIT: process.env.GOMEMLIMIT || "1536MiB",
    },
  });
}
