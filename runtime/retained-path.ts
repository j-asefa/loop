import { existsSync } from "node:fs";
import { join } from "node:path";

/** Reuse an existing durable store; never create a second empty workspace on upgrade. */
export function retainedPath(parent: string, name: string, legacy: string) {
  const current = join(parent, name);
  const prior = join(parent, legacy);
  if (existsSync(prior)) {
    if (existsSync(current))
      throw new Error(
        `Both ${current} and ${prior} exist. Choose the intended workspace explicitly before starting Loop55.`,
      );
    return prior;
  }
  return current;
}
