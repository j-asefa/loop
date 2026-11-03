#!/usr/bin/env node
// Opt-in, per-user queue setup. Does not restart Loop or interrupt agent runs.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { queueCommand, queueStatus } from "./job-client.mjs";
import { removeJobShims } from "./remove-job-shims.mjs";
import { underlyingCommand } from "./job-executables.mjs";

const version = "4.0.4";
const assets = {
  "linux-x64": [
    "x86_64-unknown-linux-musl",
    "c1b10d7e4e62211075ddd0e1dc3e8cbfc5a43d662cb3be7402a28504e23fcb51",
    "5afeff6adbafb909e8d54e2caff158e6966c2adffa2c09e60fd631cc51b60390",
  ],
  "linux-arm64": [
    "aarch64-unknown-linux-musl",
    "759bf5100a51024997111c6913aaf3330a0cdfd893ff552dcf429ae9b5e01e09",
    "332c5ef74270b64aeaf04894c8c04826f3422eb7d50dbd1a8e0706d74a42f653",
  ],
  "darwin-x64": [
    "x86_64-apple-darwin",
    "c5b89a2f9f9d355b33880735a1f12a8b8d09002f95cc7d2e5f3294e313fb8540",
    "4de7c4790989198007c6c0789c56606237d0456a2ce3666b5a0b198478c06263",
  ],
  "darwin-arm64": [
    "aarch64-apple-darwin",
    "7780dbd21e3a4106e88a57396d6dc2dbcbbae253c7e00d92d994902896b8cb82",
    "bf5a1151d70c328dd036fb6d786fba53a68d8574c12391d04db3d08b04079205",
  ],
};
const asset = assets[process.platform + "-" + process.arch];
if (!asset || typeof process.execve !== "function")
  throw new Error(
    "Job queue setup requires Node 24 on Linux or macOS (x64/arm64).",
  );
const root = join(homedir(), ".local", "lib", "loop", "job-queue");
const configDir = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "loop",
);
const state = join(
  process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
  "loop-jobs",
);
const configPath = join(configDir, "jobs.json");
const pueueConfig = join(configDir, "pueue.yml");
const tools = join(root, "tools", version);
const bin = join(root, "bin");
for (const path of [
  root,
  configDir,
  state,
  tools,
  bin,
  join(state, "runtime"),
  join(state, "controls"),
])
  await mkdir(path, { recursive: true, mode: 0o700 });
await chmod(state, 0o700);
const hash = (data) => createHash("sha256").update(data).digest("hex");
for (const [index, name] of ["pueue", "pueued"].entries()) {
  const target = join(tools, name);
  let data;
  try {
    data = await readFile(target);
  } catch {}
  if (!data || hash(data) !== asset[index + 1]) {
    const response = await fetch(
      "https://github.com/Nukesor/pueue/releases/download/v" +
        version +
        "/" +
        name +
        "-" +
        asset[0],
      { signal: AbortSignal.timeout(60000) },
    );
    if (!response.ok)
      throw new Error("Could not download the pinned " + name + " release.");
    data = Buffer.from(await response.arrayBuffer());
    if (hash(data) !== asset[index + 1])
      throw new Error(name + " release checksum mismatch.");
    await writeFile(target + ".partial", data, { mode: 0o700 });
    await rename(target + ".partial", target);
  }
  await chmod(target, 0o700);
}
const source = dirname(fileURLToPath(import.meta.url));
const files = [
  "job-client.mjs",
  "job-worker.mjs",
  "job-shim.mjs",
  "job-cli.mjs",
  "job-protocol.mjs",
  "job-peer.mjs",
];
const supervisor = await readFile(
  join(source, "../scripts/heavy-supervisor.py"),
);
const contents = await Promise.all(
  files.map((name) => readFile(join(source, name))),
);
const generation = hash(Buffer.concat([...contents, supervisor])).slice(0, 16);
const generationDir = join(root, "generations", generation);
await mkdir(join(generationDir, "deployment"), {
  recursive: true,
  mode: 0o700,
});
await mkdir(join(generationDir, "scripts"), { recursive: true, mode: 0o700 });
for (const name of files)
  await copyFile(join(source, name), join(generationDir, "deployment", name));
await writeFile(
  join(generationDir, "scripts/heavy-supervisor.py"),
  supervisor,
  { mode: 0o600 },
);
let previous;
try {
  previous = JSON.parse(await readFile(configPath, "utf8"));
} catch {}
const commands = Object.fromEntries(
  await Promise.all(
    ["node", "npm", "npx"].map(async (name) => [
      name,
      await underlyingCommand(name, {
        previous,
        bin,
        node: process.execPath,
        path: process.env.PATH,
      }),
    ]),
  ),
);
const config = {
  version: 1,
  pueue: join(tools, "pueue"),
  config: pueueConfig,
  jobs: join(state, "controls"),
  group: "loop-heavy",
  worker: join(generationDir, "deployment/job-worker.mjs"),
  shims: bin,
  commands,
};
// A dedicated daemon avoids modifying the user's own Pueue configuration.
try {
  await access(pueueConfig);
} catch {
  await writeFile(
    pueueConfig,
    JSON.stringify(
      {
        shared: {
          pueue_directory: join(state, "pueue"),
          runtime_directory: join(state, "runtime"),
        },
        daemon: { pause_group_on_failure: false, pause_all_on_failure: false },
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}
await writeFile(
  configPath + ".partial",
  JSON.stringify(config, null, 2) + "\n",
  { mode: 0o600 },
);
await rename(configPath + ".partial", configPath);
const shell = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
await removeJobShims(configPath);
await writeFile(
  join(bin, "loop-job"),
  "#!/bin/sh\nexport LOOP_JOB_QUEUE_CONFIG=" +
    shell(configPath) +
    "\nexec " +
    [commands.node, join(generationDir, "deployment/job-cli.mjs")]
      .map(shell)
      .join(" ") +
    ' "$@"\n',
  { mode: 0o700 },
);
const unitString = (value) => JSON.stringify(value.replaceAll("%", "%%"));
if (process.platform === "linux") {
  const units = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "systemd/user",
  );
  await mkdir(units, { recursive: true });
  const slice = join(units, "loop-agents-jobs.slice");
  try {
    await access(slice);
  } catch {
    await writeFile(
      slice,
      "[Unit]\nDescription=Loop build and test memory budget\n[Slice]\nMemoryAccounting=yes\nMemoryHigh=infinity\nMemoryMax=3G\nMemorySwapMax=512M\nCPUQuota=200%\nCPUWeight=50\n",
      { mode: 0o600 },
    );
  }
  await writeFile(
    join(units, "loop-job-queue.service"),
    "[Unit]\nDescription=Loop heavy command queue\n[Service]\nType=simple\nSlice=loop-agents-jobs.slice\nExecStart=" +
      unitString(join(tools, "pueued")) +
      " --config " +
      unitString(pueueConfig) +
      "\nRestart=on-failure\nRestartSec=2\nKillMode=control-group\nTimeoutStopSec=8\nOOMPolicy=continue\nOOMScoreAdjust=500\nTasksMax=512\nUMask=0077\n[Install]\nWantedBy=default.target\n",
    { mode: 0o600 },
  );
  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  execFileSync(
    "systemctl",
    ["--user", "enable", "--now", "loop-job-queue.service"],
    { stdio: "inherit" },
  );
} else {
  const xml = (s) =>
    s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const label = "dev.loop.job-queue",
    domain = "gui/" + process.getuid();
  const agents = join(homedir(), "Library/LaunchAgents");
  await mkdir(agents, { recursive: true });
  const plist = join(agents, label + ".plist");
  await writeFile(
    plist,
    '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>' +
      label +
      "</string><key>ProgramArguments</key><array>" +
      [join(tools, "pueued"), "--config", pueueConfig]
        .map((s) => "<string>" + xml(s) + "</string>")
        .join("") +
      "</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string><key>StandardOutPath</key><string>" +
      xml(join(state, "daemon.log")) +
      "</string><key>StandardErrorPath</key><string>" +
      xml(join(state, "daemon.log")) +
      "</string></dict></plist>\n",
    { mode: 0o600 },
  );
  try {
    execFileSync("launchctl", ["print", domain + "/" + label], {
      stdio: "ignore",
    });
  } catch {
    execFileSync("launchctl", ["bootstrap", domain, plist], {
      stdio: "inherit",
    });
  }
}
let ready;
for (let i = 0; i < 50; i++) {
  try {
    ready = await queueStatus(config);
    break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!ready)
  throw new Error("Queue service is not ready; Loop was not restarted.");
if (!ready.groups[config.group])
  await queueCommand(config, ["group", "add", "--parallel", "1", config.group]);
console.log("Explicit job queue is ready: " + configPath);
console.log("Inspect with: " + join(bin, "loop-job") + " status");
console.log(
  "Submit only the commands you want queued with: " +
    join(bin, "loop-job") +
    " run -- COMMAND ...",
);
