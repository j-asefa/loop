import { readFileSync } from "node:fs";
import { BuildStamp } from "../src/shared/build.ts";

export function readBuildStamp() {
  const file = process.env.LOOP_BUILD_STAMP_FILE;
  return file ? BuildStamp.parse(JSON.parse(readFileSync(file, "utf8"))) : null;
}
