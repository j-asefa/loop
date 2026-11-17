// Production routers mounted in production order (mobile before core, see
// src/server/mobile-routes.ts) with the production error handler, so tests
// see the same status codes and bodies as the running app.
import express, { type Express, type RequestHandler } from "express";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

export async function productionApp(
  owner: string | undefined,
  routers?: RequestHandler[],
  options: { ownerHeader?: string; jsonLimit?: string | number } = {},
) {
  if (!routers) {
    const { mobile } = await import("../../src/server/mobile-routes");
    const { core } = await import("../../src/server/core-routes");
    const { workspace } = await import("../../src/server/workspace-routes");
    routers = [mobile, core, workspace];
  }
  const { errorHandler } = await import("../../src/server/error-handler");
  const app = express();
  app.use(express.json({ limit: options.jsonLimit }));
  app.use((req, res, next) => {
    const headerOwner = options.ownerHeader
      ? req.get(options.ownerHeader)
      : undefined;
    res.locals.owner = owner === undefined ? headerOwner : headerOwner || owner;
    next();
  });
  app.use("/api", ...routers);
  app.use(errorHandler);
  const server = await listenForTest(app);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    fetch: (path: string, init?: RequestInit) => fetch(url + path, init),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export async function listenForTest(app: Express) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}
