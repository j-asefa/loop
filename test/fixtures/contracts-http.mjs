// The production compiled app, without a worker or any provider execution.
import { app } from "../../dist/server/index.js";
import { db } from "../../dist/server/db.js";
import { closeExecution } from "../../dist/server/execution-client.js";
import { nativeSessions } from "../../dist/server/native-sessions.js";

const server = app.listen(0, "127.0.0.1", () => {
  process.send({ port: server.address().port });
});
process.on("message", async (message) => {
  if (message !== "close") return;
  await new Promise((resolve) => server.close(resolve));
  await closeExecution();
  await nativeSessions.close();
  db.close();
  process.exit(0);
});
process.on("disconnect", () => process.exit(0));
