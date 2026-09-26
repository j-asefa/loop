#!/usr/bin/env node
import { parseArgs } from "node:util";
import { realpath, readFile, rm, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import qr from "qrcode-terminal";
import { Harness } from "./protocol.js";
import { privateDir, hash, atomic } from "./state.js";
import { Tunnel } from "./tunnel.js";
import type { Options } from "./adapters/types.js";
import { discover, control } from "./host-control.js";
const { version: VERSION } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const names = Harness.options;
function showPair(pair: { url: string; expiresIn: number }) {
  console.log(
    "\nScan with your phone camera. This single-use link expires in 2 minutes.",
  );
  qr.generate(pair.url, { small: true });
  console.log(pair.url);
  console.log(
    "Keep this terminal open. Anyone holding this link can control this workspace.\n",
  );
}
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      project: { type: "string" },
      executable: { type: "string" },
      billing: { type: "string" },
      resume: { type: "string" },
      json: { type: "boolean" },
      "local-only": { type: "boolean" },
      "public-url": { type: "string" },
    },
  });
  if (values.version) {
    console.log(VERSION);
    return;
  }
  if (values.help) {
    console.log(`Loop ${VERSION} — one workspace for your native agents

loop server
loop [codex|claude|pi|opencode] [--project PATH] [--executable PATH]
     [--billing subscription|existing] [--resume NATIVE_SESSION]
     [--local-only | --public-url https://stable-origin]
loop pair | status [--json] | devices | devices revoke ID | doctor [--json]
loop stop | uninstall

Run loop codex once, pair your phone once, and create/manage agents in the UI.
Every project and enabled harness shares this workspace host and tunnel.
Keep the owning terminal open. Phone disconnection does not stop native work.
Default billing is verified native subscription; existing mode retains your
selected native configuration and can incur API charges. No API fallback.
Native permissions, skills, plugins and project configuration are preserved.
Quick Tunnel URLs rotate. Cloudflare terminates TLS. macOS/Linux, Node >=22.19.
--resume is an explicit desktop handoff of a native session you have stopped
elsewhere. The UI does not take over arbitrary live Desktop/TUI sessions.
Uninstall removes the package separately; workspace/native history is retained.`);
    return;
  }
  if (positionals[0] === "server") {
    process.env.LOOP_PROFILE = "server";
    const { startServer } = await import("./server/serve.js");
    const { startWorker } = await import("./server/worker.js");
    const server = startServer();
    const stopWorker = startWorker();
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      server.close();
      await stopWorker();
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    return;
  }
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("This release supports macOS and Linux.");
  const root = resolve(
    process.env.LOOP_HOME ?? join(homedir(), ".local", "state", "loop"),
  );
  const dir = join(root, "workspace");
  privateDir(dir);
  const project = await realpath(resolve(values.project ?? process.cwd()));
  let action = positionals[0] === "claude-code" ? "claude" : positionals[0];
  if (action === "doctor") {
    const harnesses = await Promise.all(
      names.map((n) => discover(n, values.executable)),
    );
    console.log(
      JSON.stringify(
        {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          stateRoot: root,
          harnesses,
          workspace: await control(dir, "status").catch(() => ({
            state: "stopped",
          })),
          checks: [
            "No model request made.",
            "Native billing is checked when enabling and starting sessions.",
            "Quick Tunnel needs outbound Cloudflare connectivity.",
          ],
        },
        null,
        values.json ? 0 : 2,
      ),
    );
    return;
  }
  if (["pair", "status", "devices", "stop", "uninstall"].includes(action)) {
    if (action === "uninstall") {
      if (await control(dir, "status").catch(() => undefined))
        throw new Error("Run loop stop first.");
      console.log(
        "Workspace and native history retained at " +
          root +
          ". Remove the executable with npm uninstall -g loop. Back up this directory before manually removing workspace data.",
      );
      return;
    }
    const output = await control(
      dir,
      action === "devices" && positionals[1] === "revoke" ? "revoke" : action,
      { id: positionals[2] },
    ).catch(() => {
      if (action === "status")
        return {
          workspace: true,
          state: "stopped",
          stateRoot: root,
          message:
            "Run loop codex (or another enabled harness) to open this workspace.",
        };
      throw new Error("No responsive workspace host. Run loop codex first.");
    });
    if (action === "pair") showPair(output);
    else console.log(JSON.stringify(output, null, values.json ? 0 : 2));
    return;
  }
  if (positionals.length > 1 || (action && !names.includes(action as Harness)))
    throw new Error("Unknown command. See loop --help.");
  if (values["local-only"] && values["public-url"])
    throw new Error("Choose --local-only or --public-url.");
  const running = await control(dir, "status").catch(() => undefined);
  if (
    running &&
    !action &&
    !values.executable &&
    !values.billing &&
    !values.resume
  ) {
    console.log(
      "Your workspace is already running. All agents use the same connection.",
    );
    showPair(await control(dir, "pair"));
    return;
  }
  const preferencesPath = join(dir, "preferences.json");
  const preferences = await readFile(preferencesPath, "utf8")
    .then(JSON.parse)
    .catch(() => ({}));
  let selected = action as Harness | undefined;
  if (!selected) {
    const detected = await Promise.all(names.map((n) => discover(n)));
    const usable = detected.filter((x) => x.installed && x.supported);
    if (usable.some((x) => x.name === preferences.harness))
      selected = preferences.harness;
    else if (usable.length === 1) selected = usable[0].name;
    else if (!usable.length)
      throw new Error(
        "No supported harness installed. Run loop doctor for versions and installation links.",
      );
    else {
      if (!process.stdin.isTTY)
        throw new Error("Choose a harness: loop codex|claude|pi|opencode.");
      const input = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        console.log(usable.map((x, i) => `${i + 1}. ${x.name}`).join("\n"));
        selected =
          usable[Number(await input.question("Choose a harness: ")) - 1]?.name;
      } finally {
        input.close();
      }
      if (!selected) throw new Error("No harness selected.");
    }
  }
  const probe = await discover(selected!, values.executable);
  if (!probe.installed || !probe.supported || !probe.version)
    throw new Error(probe.help);
  let billing =
    values.billing ?? preferences.billing?.[selected!] ?? "subscription";
  if (!["subscription", "existing"].includes(billing))
    throw new Error("Billing must be subscription or existing.");
  if (
    selected === "opencode" &&
    billing === "subscription" &&
    !values.billing &&
    process.stdin.isTTY
  ) {
    const input = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      console.log(
        "OpenCode cannot prove effective subscription billing through its server.",
      );
      if (
        !/^y(es)?$/i.test(
          (
            await input.question(
              "Keep the existing OpenCode provider, which may use API credits? [y/N] ",
            )
          ).trim(),
        )
      )
        throw new Error("No billing mode selected.");
      billing = "existing";
    } finally {
      input.close();
    }
  }
  const options: Options = {
    harness: selected!,
    executable: probe.executable,
    version: probe.version,
    project,
    billing,
  };
  if (running) {
    if (values.resume)
      throw new Error(
        "Open native history in Loop, or stop the host before an explicit --resume handoff.",
      );
    const enabled = await control(dir, "enable", options);
    atomic(preferencesPath, {
      harness: selected,
      billing: { ...preferences.billing, [selected!]: billing },
    });
    console.log(
      "Enabled " +
        selected +
        " in your existing workspace. " +
        enabled.billing.description,
    );
    console.log(
      "Your paired phone can create agents immediately; no new pairing is required.",
    );
    return;
  }
  const { workspaceLock } = await import("./lifecycle.js");
  const release = workspaceLock(dir);
  let host: import("./workspace-host.js").WorkspaceHost | undefined;
  let tunnel: Tunnel | undefined,
    stopping = false,
    retries = 0;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await tunnel?.stop();
      await host?.close();
    } finally {
      release();
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void stop();
    });
  try {
    process.env.LOOP_DATA_DIR = dir;
    process.env.LOOP_PROFILE = "companion";
    const { WorkspaceHost } = await import("./workspace-host.js");
    if (stopping) return;
    host = new WorkspaceHost(dir, options);
    host.gateway.onStop = stop;
    const { migrateLegacy, resumeFromDesktop } =
      await import("./server/migration.js");
    const enabled = await host.start(options, async () => {
      await migrateLegacy(root);
      if (!stopping && values.resume) resumeFromDesktop(options, values.resume);
    });
    if (stopping) {
      await host.close();
      return;
    }
    atomic(preferencesPath, {
      harness: selected,
      billing: { ...preferences.billing, [selected!]: billing },
    });
    if (stopping) return;
    console.log("Loop workspace ready. " + enabled.billing.description);
    console.log(
      "Create agents in Loop; multiple agents may use the same project. Commands: loop status, loop pair, loop stop.",
    );
    const connect = async () => {
      tunnel = new Tunnel(root, host!.port, () => {
        if (stopping) return;
        console.error(
          "Quick Tunnel disconnected. Desktop work continues; a new origin requires pairing again.",
        );
        if (++retries <= 3)
          setTimeout(() => {
            if (!stopping)
              void connect().catch((e) => console.error(e.message));
          }, 1000);
      });
      const origin = await tunnel.start();
      if (!stopping) {
        host!.setOrigin(origin);
        showPair(host!.pair());
      }
    };
    if (values["public-url"]) {
      host.setOrigin(values["public-url"]);
      console.log("Point the HTTPS tunnel to http://127.0.0.1:" + host.port);
      showPair(host.pair());
    } else if (values["local-only"]) {
      console.log("Local-only: open this link on the desktop.");
      showPair(host.pair());
    } else {
      console.log("Preparing verified cloudflared Quick Tunnel…");
      await connect();
    }
  } catch (error) {
    await stop();
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(await realpath(process.argv[1]).catch(() => process.argv[1]))
      .href
)
  main().catch((e) => {
    console.error("Loop: " + e.message);
    process.exitCode = 1;
  });
