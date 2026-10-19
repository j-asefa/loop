import { readFileSync } from "node:fs";
import { runningBuild, type BuildStamp } from "../shared/build.js";
let invalidated = false;

/** The identity is compiled into the loaded module. An in-place installation
 * can replace lazily imported modules/assets before restart, so that process
 * loses clean provenance rather than adopting the new files' identity. */
export function observedBuild(): BuildStamp {
  if (!runningBuild.clean) return runningBuild;
  try {
    if (
      !invalidated &&
      JSON.parse(
        readFileSync(new URL("../build-id.json", import.meta.url), "utf8"),
      ).id === runningBuild.id
    )
      return runningBuild;
  } catch {}
  invalidated = true;
  return { ...runningBuild, clean: false };
}
