import { execFileSync } from "node:child_process";
import { hostname, platform } from "node:os";

let cached: string | undefined;

// Read on the execution host, once per process. A Mac's ComputerName is the
// friendly name from System Settings; its network hostname can be different.
export function computerName(): string {
  if (cached !== undefined) return cached;
  if (platform() === "darwin") {
    try {
      const name = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
        timeout: 1_000,
        maxBuffer: 4_096,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (name) return (cached = name);
    } catch {
      // Missing preferences or a failed lookup must not prevent startup.
    }
  }
  try {
    return (cached = hostname().trim() || "This computer");
  } catch {
    return (cached = "This computer");
  }
}
