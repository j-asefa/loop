#!/usr/bin/env node
import "../runtime/environment.mjs";
// Retire automatic queue wrappers without breaking PATHs held by live shells.
import { randomUUID } from "node:crypto";
import { existsSync, constants } from "node:fs";
import {
  access,
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configRoot = () =>
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const defaultConfig = () => {
  const current = join(configRoot(), "loop55/jobs.json");
  const legacy = join(configRoot(), "loop/jobs.json");
  if (existsSync(current) && existsSync(legacy))
    throw new Error(
      "Both Loop55 and legacy queue configurations exist; choose one explicitly.",
    );
  return existsSync(legacy) ? legacy : current;
};
const marker = "# Loop55 command passthrough; automatic queueing removed.";
const shell = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export async function removeJobShims(
  configPath = process.env.LOOP55_JOB_QUEUE_CONFIG || defaultConfig(),
) {
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (typeof config.shims !== "string" || !isAbsolute(config.shims))
    throw new Error("Invalid installed Loop55 command wrapper directory.");
  const directory = await realpath(config.shims).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!directory) return [];
  const updates = [];
  for (const name of ["node", "npm", "npx"]) {
    const path = join(directory, name);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile())
      throw new Error("Refusing to replace a non-file wrapper: " + path);
    const existing = await readFile(path, "utf8");
    if (
      !existing.startsWith("#!/bin/sh\n" + marker + "\n") &&
      !existing.startsWith(
        "#!/bin/sh\n# Loop command passthrough; automatic queueing removed.\n",
      ) &&
      !(
        /^#!\/bin\/sh\nexport LOOP(?:55)?_JOB_QUEUE_CONFIG=/.test(existing) &&
        existing.includes("job-shim.mjs") &&
        /Loop(?:55)? command queue configuration is unavailable/.test(existing)
      )
    )
      throw new Error("Unrecognized command wrapper; left unchanged: " + path);
    const command = config.commands?.[name];
    if (
      typeof command !== "string" ||
      !isAbsolute(command) ||
      dirname(await realpath(command)) === directory
    )
      throw new Error("Invalid underlying " + name + " executable.");
    await access(command, constants.X_OK);
    // A shell exec preserves the native PID and protocol descriptors above 2.
    const body =
      "#!/bin/sh\n" +
      marker +
      "\nunset LOOP_JOB_QUEUE_CONFIG LOOP_JOB_SHIMS LOOP_JOB_ACTIVE LOOP55_JOB_QUEUE_CONFIG LOOP55_JOB_SHIMS LOOP55_JOB_ACTIVE\n" +
      "export LOOP_HEAVY_SCHEDULING=off LOOP55_HEAVY_SCHEDULING=off\nexec " +
      shell(command) +
      ' "$@"\n';
    if (body !== existing) updates.push({ name, path, body });
  }
  // Validate every target before changing any wrapper. Do not touch queued jobs.
  for (const { path, body } of updates) {
    const temporary = path + "." + randomUUID() + ".partial";
    try {
      await writeFile(temporary, body, { mode: 0o700, flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return updates.map(({ name }) => name);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const updated = await removeJobShims(process.argv[2]);
  console.log(
    "Automatic test queue wrappers retired: " +
      (updated.join(", ") || "none remaining"),
  );
}
