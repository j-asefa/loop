import { pathToFileURL } from "node:url";
import { realpath } from "node:fs/promises";
import { config } from "./config.js";
import { companionMode } from "./profile.js";
if (companionMode)
  throw new Error(
    "Start companion mode using loop so device authorization is installed.",
  );
const { app } = await import("./index.js");
export function startServer() {
  return app.listen(config.port, config.listenHost, () =>
    console.log(`Loop listening on ${config.port}`),
  );
}
if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(await realpath(process.argv[1]).catch(() => process.argv[1]))
      .href
) {
  const server = startServer();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => server.close());
}
