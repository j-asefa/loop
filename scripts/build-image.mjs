// Supply Docker with the exact source snapshot whose identity we recorded.
// A plain docker build remains supported, with unknown source provenance.
import { spawnSync } from "node:child_process";
import { writeFile, realpath } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import { buildSource } from "./build-source.mjs";
const source = await buildSource(process.cwd());
try {
  const args = ["build", ...process.argv.slice(2)];
  if (source.stamp.clean) {
    const capturedFile = async (file) => {
      const path = relative(process.cwd(), resolve(file));
      const captured = resolve(source.directory, path);
      const inside = (candidate) => {
        const rel = relative(source.directory, candidate);
        return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
      };
      if (
        file === "-" ||
        !inside(captured) ||
        !inside(await realpath(captured))
      )
        throw new Error(
          "Provenance builds require a Dockerfile inside the captured repository. Use docker build for external Dockerfiles.",
        );
      return captured;
    };
    let selected = false;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "-f" || args[i] === "--file") {
        if (!args[i + 1]) throw new Error("A Dockerfile path is required");
        i++;
        args[i] = await capturedFile(args[i]);
        selected = true;
      } else if (args[i].startsWith("--file=") || args[i].startsWith("-f")) {
        const file = args[i].startsWith("--file=")
          ? args[i].slice(7)
          : args[i].startsWith("-f=")
            ? args[i].slice(3)
            : args[i].slice(2);
        args[i] = "--file=" + (await capturedFile(file));
        selected = true;
      }
    }
    if (!selected) args.push("--file", await capturedFile("Dockerfile"));
    await writeFile(
      join(source.directory, ".loop55-build-source.json"),
      JSON.stringify(source.stamp),
    );
    args.push(
      "--build-arg",
      "LOOP55_BUILD_SOURCE_FILE=.loop55-build-source.json",
    );
  }
  const result = spawnSync("docker", [...args, source.directory], {
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("Docker build failed");
} finally {
  await source.cleanup();
}
