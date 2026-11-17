// Production routers mounted in production order (mobile before core, see
// src/server/mobile-routes.ts) with the production error handler, so tests
// see the same status codes and bodies as the running app.
import express, { type Router } from "express";
import type { AddressInfo } from "node:net";

export async function productionApp(
  owner: string,
  routers?: Router[],
  options: { ownerHeader?: string } = {},
) {
  if (!routers) {
    const { mobile } = await import("../../src/server/mobile-routes");
    const { core } = await import("../../src/server/core-routes");
    const { workspace } = await import("../../src/server/workspace-routes");
    routers = [mobile, core, workspace];
  }
  const { errorHandler } = await import("../../src/server/error-handler");
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.owner = options.ownerHeader
      ? req.get(options.ownerHeader) || owner
      : owner;
    next();
  });
  app.use("/api", ...routers);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    fetch: (path: string, init?: RequestInit) => fetch(url + path, init),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
