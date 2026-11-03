import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const exec = promisify(execFile);
const xml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const unit = (s: string) =>
  '"' +
  s
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("\n", "\\n") +
  '"';
// WorkingDirectory= takes its value literally: quotes would become part of
// the path. Only specifiers need escaping.
const literalPath = (s: string) => {
  if (/[\n\r]/.test(s))
    throw new Error("Service paths cannot contain newlines");
  return s.replaceAll("%", "%%");
};
export const SERVICES = {
  darwin: { app: "dev.loop.workspace", connection: "dev.loop.connection" },
  linux: { app: "loop.service", connection: "loop-connection.service" },
};
type Definition = { name: string; contents: string };
/**
 * Two independently supervised services: the connection service (relay and
 * cloudflared) and the application. Restarting the application unit never
 * signals the connection's process tree, so its address survives. Both
 * restart only after failure, so loop stop is not undone by the supervisor.
 */
export function serviceDefinitions(
  platform: string,
  node: string,
  cli: string,
  root: string,
  project: string,
  path: string,
  /** Tunnel arguments for the connection unit; null when there is no tunnel. */
  tunnel: string[] | null = [],
  launch: string[] = ["start", "--project", project],
): { connection?: Definition; app: Definition } {
  // The saved launch, as loop restart repeats it. Without a tunnel (local-only
  // or a user-managed proxy) there is no connection service to supervise.
  const app = [
    node,
    cli,
    ...launch.filter((a) => a !== "--foreground"),
    "--foreground",
  ];
  const connection = tunnel
    ? [node, cli, "connection", "--foreground", ...tunnel]
    : undefined;
  if (platform === "darwin") {
    const plist = (
      label: string,
      args: string[],
      env: Record<string, string>,
      log: string,
    ) =>
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((s) => `<string>${xml(s)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(project)}</string><key>EnvironmentVariables</key><dict>${Object.entries(
        { LOOP_HOME: root, PATH: path, ...env },
      )
        .map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`)
        .join(
          "",
        )}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key><string>${xml(join(root, log))}</string><key>StandardErrorPath</key><string>${xml(join(root, log))}</string></dict></plist>\n`;
    return {
      connection: connection && {
        name: SERVICES.darwin.connection,
        contents: plist(
          SERVICES.darwin.connection,
          connection,
          {},
          "connection-service.log",
        ),
      },
      app: {
        name: SERVICES.darwin.app,
        contents: plist(
          SERVICES.darwin.app,
          app,
          {
            ...(connection ? { LOOP_CONNECTION_MANAGED: "external" } : {}),
            LOOP_SERVICE: "launchd",
          },
          "workspace/service.log",
        ),
      },
    };
  }
  if (platform !== "linux")
    throw new Error("User services support macOS and Linux");
  return {
    connection: connection && {
      name: SERVICES.linux.connection,
      contents: `[Unit]\nDescription=Loop connection service (tunnel and relay)\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${literalPath(project)}\nEnvironment=${unit("LOOP_HOME=" + root)}\nEnvironment=${unit("PATH=" + path)}\nExecStart=${connection.map(unit).join(" ")}\nRestart=on-failure\nRestartSec=10\nKillMode=control-group\nTimeoutStopSec=15\n\n[Install]\nWantedBy=default.target\n`,
    },
    app: {
      name: SERVICES.linux.app,
      // Wants, not Requires: restarting either unit leaves the other alone.
      contents: `[Unit]\nDescription=Loop laptop workspace\nAfter=network-online.target${connection ? ` ${SERVICES.linux.connection}\nWants=${SERVICES.linux.connection}` : ""}\n\n[Service]\nType=simple\nWorkingDirectory=${literalPath(project)}\nEnvironment=${unit("LOOP_HOME=" + root)}\nEnvironment=${unit("PATH=" + path)}\n${connection ? 'Environment="LOOP_CONNECTION_MANAGED=external"\n' : ""}Environment="LOOP_SERVICE=systemd"\nExecStart=${app.map(unit).join(" ")}\nRestart=on-failure\nRestartSec=30\nKillMode=control-group\nTimeoutStopSec=30\n\n[Install]\nWantedBy=default.target\n`,
    },
  };
}
/** Preserve native adapter options across upgrades; laptop was the old launcher alias. */
export function migrateLaunchArgs(args: string[]) {
  if (!["start", "laptop"].includes(args[0])) return args;
  const next = ["start"];
  for (let i = 1; i < args.length; i++) {
    const key = args[i].split("=")[0];
    if (["--executable", "--billing", "--execution"].includes(key)) {
      if (!args[i].includes("=")) i++;
    } else next.push(args[i]);
  }
  return [...next, "--execution", "native"];
}

/** Repoint the executable and migrate legacy argv in installed service units. */
export function repointUnit(
  platform: string,
  contents: string,
  cli: string,
  where = "its service definition",
) {
  const mac = platform === "darwin";
  const pattern = mac
    ? /(<key>ProgramArguments<\/key><array>)(.*?)(<\/array>)/s
    : /^(ExecStart=)([^\n]*)(.*)$/m;
  const found = contents.match(pattern);
  const unreadable = () =>
    new Error(
      `Loop could not read the executable from ${where}, so it cannot point that service at this build. Run loop service install from the new build, then loop restart.`,
    );
  if (!found) throw unreadable();
  let args: string[];
  try {
    if (mac) {
      const entries = [...found[2].matchAll(/<string>([^<]*)<\/string>/g)];
      if (entries.map((entry) => entry[0]).join("") !== found[2])
        throw unreadable();
      args = entries.map((entry) =>
        entry[1].replace(
          /&(amp|lt|gt|quot|apos);/g,
          (_match, entity: string) =>
            ({ amp: "&", lt: "<", gt: ">", quot: '\"', apos: "'" })[entity]!,
        ),
      );
    } else {
      const entries = found[2].match(/"(?:\\.|[^"\\])*"/g) || [];
      if (entries.join(" ") !== found[2]) throw unreadable();
      args = entries.map((entry) =>
        (JSON.parse(entry) as string).replaceAll("%%", "%"),
      );
    }
    if (args.length < 3) throw unreadable();
  } catch {
    throw unreadable();
  }
  const next = [args[0], cli, ...migrateLaunchArgs(args.slice(2))];
  if (JSON.stringify(next) === JSON.stringify(args)) return null;
  return contents.replace(
    pattern,
    (_match, before, _old, after) =>
      before +
      (mac
        ? next.map((arg) => `<string>${xml(arg)}</string>`).join("")
        : next.map(unit).join(" ")) +
      after,
  );
}

/**
 * Points the installed application unit at `cli` and reloads it, leaving the
 * connection unit — and the public address it holds — running.
 *
 * An upgrade installs the new build somewhere else (npm's global prefix, say)
 * while the unit still names the build it was installed from, typically a
 * checkout. Without this the manager relaunches the old code, so the upgrade
 * reports success while Loop keeps serving the previous release.
 *
 * Returns "absent" when there is no unit to point, "unchanged" when it already
 * names this build (the caller restarts it as usual), and "repointed" when the
 * unit was rewritten and reloaded, which also starts the application.
 */
export async function repointAppService(cli: string, root: string) {
  // A fixture or second workspace may share the OS user's home. Its upgrade
  // must not rewrite or restart the production workspace's installed units.
  if (!(await installedSupervisor(root))) return "absent" as const;
  const mac = process.platform === "darwin";
  const names = (await installedServiceNames(root))!;
  const unitFile = (name: string) =>
    join(
      homedir(),
      mac ? "Library/LaunchAgents" : ".config/systemd/user",
      mac ? `${name}.plist` : name,
    );
  const file = unitFile(names.app);
  const contents = await readFile(file, "utf8").catch(() => undefined);
  if (contents === undefined) return "absent" as const;
  const next = repointUnit(process.platform, contents, cli, file);
  // The connection unit keeps running the build it was installed from: that is
  // what carries the tunnel and the public address across the upgrade. Its
  // definition is still pointed at the new build, or the next reboot would
  // start the old release's connection service -- or fail outright, once that
  // path is gone. Written, never reloaded.
  const connection = unitFile(names.connection);
  const running = await readFile(connection, "utf8").catch(() => undefined);
  if (running !== undefined) {
    const pointed = repointUnit(process.platform, running, cli, connection);
    if (pointed) await writeFile(connection, pointed, { mode: 0o600 });
  }
  if (!next) return "unchanged" as const;
  await writeFile(file, next, { mode: 0o600 });
  const uid = process.getuid!();
  if (mac) {
    // launchd holds the loaded job's arguments, so the plist is reloaded
    // rather than kickstarted. Only the application label is touched.
    await exec("launchctl", ["bootout", `gui/${uid}/${names.app}`]).catch(
      () => {},
    );
    await exec("launchctl", ["bootstrap", `gui/${uid}`, file]);
  } else {
    await exec("systemctl", ["--user", "daemon-reload"]);
    await exec("systemctl", ["--user", "restart", names.app]);
  }
  return "repointed" as const;
}
/**
 * The service manager that owns the installed application unit for `root`, if
 * any. Read from disk because the application reports its own supervisor, and
 * a restart most needs to route to the manager exactly when the application is
 * too hung to answer at all.
 *
 * Matched on the unit's own LOOP_HOME: a unit installed for a different
 * workspace is somebody else's, and kickstarting it from here would restart a
 * workspace the caller never named.
 */
export async function installedServiceNames(root: string) {
  const mac = process.platform === "darwin";
  for (const names of [mac ? SERVICES.darwin : SERVICES.linux]) {
    const file = join(
      homedir(),
      mac ? "Library/LaunchAgents" : ".config/systemd/user",
      mac ? `${names.app}.plist` : names.app,
    );
    const contents = await readFile(file, "utf8").catch(() => undefined);
    if (contents === undefined) continue;
    const home = mac
      ? contents.match(
          /<key>LOOP(?:55)?_HOME<\/key><string>([^<]*)<\/string>/,
        )?.[1]
      : contents.match(
          /^Environment="LOOP(?:55)?_HOME=((?:\\.|[^"\\])*)"/m,
        )?.[1];
    if (home === (mac ? xml(root) : unit(root).slice(1, -1))) return names;
  }
}
export async function installedSupervisor(root: string) {
  if (!(await installedServiceNames(root))) return undefined;
  return process.platform === "darwin" ? "launchd" : "systemd";
}
export async function userService(
  action: string,
  cli: string,
  root: string,
  project: string,
  tunnel: string[] | null = [],
  launch?: string[],
) {
  const mac = process.platform === "darwin";
  const dir = mac
    ? join(homedir(), "Library/LaunchAgents")
    : join(homedir(), ".config/systemd/user");
  const names = mac ? SERVICES.darwin : SERVICES.linux;
  const prior = await installedServiceNames(root);
  const retired =
    prior && prior.app !== names.app ? [prior.app, prior.connection] : [];
  const file = (name: string) => join(dir, mac ? `${name}.plist` : name);
  if (!["install", "uninstall"].includes(action))
    throw new Error("Use loop service install or loop service uninstall");
  const uid = process.getuid!();
  // Stop the application before the connection, and start it after.
  const stop = async () => {
    for (const name of [names.app, names.connection, ...retired]) {
      if (mac)
        await exec("launchctl", ["bootout", `gui/${uid}/${name}`]).catch(
          () => {},
        );
      else
        await exec("systemctl", ["--user", "disable", "--now", name]).catch(
          () => {},
        );
    }
  };
  if (action === "install") {
    const definitions = serviceDefinitions(
      process.platform,
      process.execPath,
      cli,
      root,
      project,
      process.env.PATH || "",
      tunnel,
      launch,
    );
    // Replacing an existing installation never runs two copies at once.
    await stop();
    for (const name of retired) await rm(file(name), { force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await rm(file(names.connection), { force: true });
    const installed = [definitions.connection, definitions.app].filter(
      (d): d is Definition => !!d,
    );
    for (const definition of installed)
      await writeFile(file(definition.name), definition.contents, {
        mode: 0o600,
      });
    if (mac)
      for (const { name } of installed)
        await exec("launchctl", ["bootstrap", `gui/${uid}`, file(name)]);
    else {
      await exec("systemctl", ["--user", "daemon-reload"]);
      await exec("systemctl", [
        "--user",
        "enable",
        "--now",
        ...installed.map(({ name }) => name),
      ]);
    }
  } else {
    await stop();
    for (const name of [names.app, names.connection, ...retired])
      await rm(file(name), { force: true });
    if (!mac)
      await exec("systemctl", ["--user", "daemon-reload"]).catch(() => {});
  }
}
