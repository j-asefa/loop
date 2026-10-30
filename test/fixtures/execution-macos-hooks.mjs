// Exercise compiled macOS ownership paths with a controlled boot-session UUID.
// This is platform emulation on Linux, not a live macOS acceptance test.
import childProcess from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
new Database(":memory:").close(); // Load the actual host's native binding first.
Object.defineProperty(process, "platform", { value: "darwin" });
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = function (command, args, options) {
  if (command === "/usr/sbin/sysctl") {
    if (JSON.stringify(args) !== JSON.stringify(["-n", "kern.bootsessionuuid"]))
      throw new Error("Unexpected fixture sysctl query");
    return process.env.LOOP55_TEST_BOOT_SESSION + "\n";
  }
  return execFileSync.call(this, command, args, options);
};
syncBuiltinESMExports();
