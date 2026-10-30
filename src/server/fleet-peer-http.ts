import express, { type ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { FleetOrigin } from "../shared/fleet.js";
import { fleetWorkspaceApi } from "../shared/fleet-workspace-api.js";
import { fleetWorkspaceActionApi } from "../shared/fleet-workspace-action-api.js";
import type { FleetWorkspaceRead } from "./fleet-workspace-read.js";
import type { FleetWorkspaceActions } from "./fleet-workspace-actions.js";
import type { FleetWorkspaceFiles } from "./fleet-workspace-files.js";
import { fleetWorkspaceFileApi } from "../shared/fleet-workspace-file-api.js";
import type { FleetWorkspaceUploads } from "./fleet-workspace-uploads.js";
import { fleetWorkspaceUploadApi } from "../shared/fleet-workspace-upload-api.js";
import { fleetPeerApi } from "../shared/fleet-peer-api.js";
import { fleetHandoffApi } from "../shared/fleet-handoff-api.js";
import { fleetDirectoryApi } from "../shared/fleet-directory-api.js";
import { fleetCredentialApi } from "../shared/fleet-credential-api.js";
import { fleetPendingDirectoryApi } from "../shared/fleet-pending-directory-api.js";
import { Problem } from "../shared/problem.js";
import { registrar } from "./registrar.js";
import type { FleetEnrollmentDestination } from "./fleet-enrollment.js";
import type { FleetHandoffDestination } from "./fleet-handoff.js";
import type { FleetDirectorySync } from "./fleet-directory-sync.js";
import type { FleetCredentials } from "./fleet-credentials.js";
import type { FleetPendingDirectory } from "./fleet-pending-directory.js";

/** This application has only fixed fleet protocol handlers. It cannot fall through
 * to arbitrary workspace routes, native bridges, browser sessions or local admin. */
export function createFleetPeerHttp(
  destination: FleetEnrollmentDestination,
  origin: () => string,
  options: {
    handoff?: FleetHandoffDestination;
    directory?: FleetDirectorySync;
    credentials?: FleetCredentials;
    pendingDirectory?: FleetPendingDirectory;
    workspaceRead?: FleetWorkspaceRead;
    workspaceActions?: FleetWorkspaceActions;
    workspaceFiles?: FleetWorkspaceFiles;
    workspaceUploads?: FleetWorkspaceUploads;
  } = {},
) {
  const paths = new Set(
    [
      ...Object.values(fleetPeerApi),
      ...(options.workspaceRead ? Object.values(fleetWorkspaceApi) : []),
      ...(options.workspaceActions
        ? Object.values(fleetWorkspaceActionApi)
        : []),
      ...(options.workspaceFiles ? Object.values(fleetWorkspaceFileApi) : []),
      ...(options.workspaceUploads
        ? Object.values(fleetWorkspaceUploadApi)
        : []),
      ...(options.handoff ? Object.values(fleetHandoffApi) : []),
      ...(options.directory ? Object.values(fleetDirectoryApi) : []),
      ...(options.credentials ? Object.values(fleetCredentialApi) : []),
      ...(options.pendingDirectory
        ? Object.values(fleetPendingDirectoryApi)
        : []),
    ].map((route) => "/api" + route.path),
  );
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  let pending = 0;
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const current = FleetOrigin.safeParse(origin());
    if (!current.success)
      return res
        .status(503)
        .json({ error: "The fleet HTTPS endpoint is unavailable." });
    if (req.headers.host !== new URL(current.data).host)
      return res.status(403).json({ error: "Unrecognized host." });
    if (
      [
        "origin",
        "cookie",
        "authorization",
        "x-loop55-csrf",
        "x-http-method-override",
        "x-method-override",
      ].some((header) => req.headers[header] !== undefined) ||
      Object.keys(req.headers).some((header) => header.startsWith("sec-fetch-"))
    )
      return res.status(403).json({
        error: "Use machine protocol proofs without browser credentials.",
      });
    // Match the raw path before Express normalization or body parsing. No query,
    // encoded path, trailing slash or unrelated route reaches a protocol handler.
    if (!paths.has(req.url))
      return res.status(404).json({ error: "Unknown fleet endpoint." });
    if (req.method !== "POST")
      return res
        .status(405)
        .json({ error: "Use POST for the fleet protocol." });
    if (req.headers["x-loop55-fleet-version"] !== "1")
      return res
        .status(400)
        .json({ error: "Unsupported fleet protocol version." });
    if (
      req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
      "application/json"
    )
      return res
        .status(415)
        .json({ error: "Use a JSON fleet protocol request." });
    if (pending >= 16) {
      res.setHeader("Retry-After", "1");
      return res
        .status(503)
        .json({ error: "The fleet protocol is busy. Try again later." });
    }
    pending++;
    const timer = setTimeout(() => {
      res.destroy();
      req.destroy();
    }, 15_000);
    timer.unref();
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      pending--;
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  });
  app.use(express.json({ limit: "4mb", strict: true }));
  const routes = registrar("fleet-peer-protocol", {
    prefix: "/api",
    automaticOptions: false,
  });
  routes.on(fleetPeerApi.enrollmentProbe, ({ body }, res) =>
    res.json(destination.probe(body)),
  );
  routes.on(fleetPeerApi.enrollmentPrepare, ({ body }, res) =>
    res.json(destination.prepare(body)),
  );
  routes.on(fleetPeerApi.enrollmentCommit, ({ body }, res) =>
    res.json(destination.commit(body)),
  );
  routes.on(fleetPeerApi.enrollmentReceipt, ({ body }, res) =>
    res.json(destination.receipt(body)),
  );
  if (options.handoff) {
    const handoff = options.handoff;
    routes.on(fleetHandoffApi.handoffCommit, ({ body }, res) =>
      res.json(handoff.commit(body)),
    );
    routes.on(fleetHandoffApi.handoffReceipt, ({ body }, res) =>
      res.json(handoff.receipt(body)),
    );
  }
  if (options.directory) {
    const directory = options.directory;
    routes.on(fleetDirectoryApi.directoryHistory, ({ body }, res) =>
      res.json(directory.history(body)),
    );
    routes.on(fleetDirectoryApi.directoryPush, ({ body }, res) =>
      res.json(directory.receive(body)),
    );
  }
  if (options.credentials) {
    const credentials = options.credentials;
    routes.on(fleetCredentialApi.credentialChallenge, ({ body }, res) =>
      res.json(credentials.challenge(body)),
    );
    routes.on(fleetCredentialApi.credentialIssue, ({ body }, res) =>
      res.json(credentials.issue(body)),
    );
  }
  if (options.pendingDirectory) {
    const pending = options.pendingDirectory;
    routes.on(fleetPendingDirectoryApi.pendingDirectoryHead, ({ body }, res) =>
      res.json(pending.history(body)),
    );
    routes.on(fleetPendingDirectoryApi.pendingDirectoryPush, ({ body }, res) =>
      res.json(pending.receive(body)),
    );
  }
  if (options.workspaceRead) {
    const workspace = options.workspaceRead;
    routes.on(fleetWorkspaceApi.catalog, ({ body }, res) =>
      res.json(workspace.catalog(body)),
    );
    routes.on(fleetWorkspaceApi.read, async ({ body }, res) =>
      res.json(await workspace.read(body)),
    );
  }
  if (options.workspaceActions) {
    const workspace = options.workspaceActions;
    routes.on(fleetWorkspaceActionApi.action, async ({ body }, res) =>
      res.json(await workspace.action(body)),
    );
    routes.on(fleetWorkspaceActionApi.receipt, ({ body }, res) =>
      res.json(workspace.receipt(body)),
    );
  }
  if (options.workspaceFiles) {
    const files = options.workspaceFiles;
    routes.on(fleetWorkspaceFileApi.open, async ({ body }, res) => {
      const controller = new AbortController();
      const close = () => {
        if (!res.writableFinished) controller.abort();
      };
      res.once("close", close);
      res.once("finish", () => res.off("close", close));
      res.json(await files.open(body, controller.signal));
    });
    routes.on(fleetWorkspaceFileApi.chunk, ({ body }, res) =>
      res.json(files.chunk(body)),
    );
    routes.on(fleetWorkspaceFileApi.close, ({ body }, res) =>
      res.json(files.release(body)),
    );
  }
  if (options.workspaceUploads) {
    const uploads = options.workspaceUploads;
    routes.on(fleetWorkspaceUploadApi.prepare, ({ body }, res) => {
      const controller = new AbortController();
      const close = () => {
        if (!res.writableFinished) controller.abort();
      };
      res.once("close", close);
      res.once("finish", () => res.off("close", close));
      res.json(uploads.prepare(body, controller.signal));
    });
    routes.on(fleetWorkspaceUploadApi.chunk, ({ body }, res) =>
      res.json(uploads.chunk(body)),
    );
    routes.on(fleetWorkspaceUploadApi.close, ({ body }, res) =>
      res.json(uploads.release(body)),
    );
    routes.on(fleetWorkspaceUploadApi.commit, async ({ body }, res) =>
      res.json(await uploads.commit(body)),
    );
    routes.on(fleetWorkspaceUploadApi.receipt, ({ body }, res) =>
      res.json(uploads.receipt(body)),
    );
  }
  app.use(routes.mount);
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    if (error instanceof Problem)
      return res.status(error.status).json({ error: error.message });
    const status =
      error?.status === 413
        ? 413
        : error instanceof ZodError || error?.type === "entity.parse.failed"
          ? 400
          : 500;
    // Body-parser and Zod diagnostics can include capability-bearing input.
    return res
      .status(status)
      .json({ error: "The fleet protocol request is unavailable." });
  };
  app.use(errors);
  return app;
}
