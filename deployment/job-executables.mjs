import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export async function underlyingCommand(name, { previous, bin, node, path }) {
  // The interpreter running this installation is the one known to work now.
  if (name === "node") return node;
  const shimDirectory = await realpath(bin).catch(() => resolve(bin));
  const candidates = [
    previous?.commands?.[name],
    ...(path || "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, name)),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !isAbsolute(candidate)) continue;
    try {
      const actual = await realpath(candidate);
      if (dirname(actual) === shimDirectory) continue;
      await access(actual, constants.X_OK);
      if ((await stat(actual)).isFile()) return candidate;
    } catch {}
  }
  throw new Error("Cannot find the underlying " + name + " executable.");
}
