import { pathToFileURL } from "node:url";
import { realpath } from "node:fs/promises";
import { config } from "./config.js";
import { companionMode } from "./profile.js";
import { observeProcess } from "./deployments.js";
if (companionMode)
  throw new Error(
    "Start companion mode using loop55 so device authorization is installed.",
  );
const { app, authorizeIntegrationToken } = await import("./index.js");
const { installEventSockets } = await import("./event-sockets.js");
export function startServer() {
  let stop: (() => void) | undefined;
  const server = app.listen(config.port, config.listenHost, () => {
    stop = observeProcess("api");
    console.log(`Loop55 listening on ${config.port}`);
  });
  installEventSockets(server, authorizeIntegrationToken);
  server.once("close", () => stop?.());
  return server;
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
