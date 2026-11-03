import { control } from "../dist/host-control.js";
import { join } from "node:path";
try {
  const status = await control(
    join(process.env.LOOP_HOME, "workspace"),
    "status",
  );
  if (!status.url || !status.pid) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
