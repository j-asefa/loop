import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm } from "node:fs/promises";
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
export function serviceDefinition(
  platform: string,
  node: string,
  cli: string,
  root: string,
  project: string,
  path: string,
) {
  const args = [node, cli, "start", "--foreground", "--project", project];
  if (platform === "darwin")
    return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>dev.loop.workspace</string><key>ProgramArguments</key><array>${args.map((s) => `<string>${xml(s)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(project)}</string><key>EnvironmentVariables</key><dict><key>LOOP_HOME</key><string>${xml(root)}</string><key>PATH</key><string>${xml(path)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key><string>${xml(join(root, "workspace/service.log"))}</string><key>StandardErrorPath</key><string>${xml(join(root, "workspace/service.log"))}</string></dict></plist>\n`;
  if (platform !== "linux")
    throw new Error("User services support macOS and Linux");
  return `[Unit]\nDescription=Loop laptop workspace\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${unit(project)}\nEnvironment=${unit("LOOP_HOME=" + root)}\nEnvironment=${unit("PATH=" + path)}\nExecStart=${args.map(unit).join(" ")}\nRestart=on-failure\nRestartSec=30\nKillMode=control-group\nTimeoutStopSec=30\n\n[Install]\nWantedBy=default.target\n`;
}
export async function userService(
  action: string,
  cli: string,
  root: string,
  project: string,
) {
  const mac = process.platform === "darwin";
  const path = mac
    ? join(homedir(), "Library/LaunchAgents/dev.loop.workspace.plist")
    : join(homedir(), ".config/systemd/user/loop.service");
  if (!["install", "uninstall"].includes(action))
    throw new Error("Use loop service install or loop service uninstall");
  if (action === "install") {
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(
      path,
      serviceDefinition(
        process.platform,
        process.execPath,
        cli,
        root,
        project,
        process.env.PATH || "",
      ),
      { mode: 0o600 },
    );
    if (mac)
      await exec("launchctl", ["bootstrap", `gui/${process.getuid!()}`, path]);
    else {
      await exec("systemctl", ["--user", "daemon-reload"]);
      await exec("systemctl", ["--user", "enable", "--now", "loop.service"]);
    }
  } else {
    if (mac)
      await exec("launchctl", [
        "bootout",
        `gui/${process.getuid!()}/dev.loop.workspace`,
      ]);
    else
      await exec("systemctl", ["--user", "disable", "--now", "loop.service"]);
    await rm(path, { force: true });
  }
}
