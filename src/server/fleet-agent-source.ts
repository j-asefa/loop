import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { SourceAdapter } from "../agent-sources.js";
import { Problem } from "../shared/problem.js";
import { Capabilities } from "../shared/capabilities.js";
import { matchFleetRoute as match } from "../shared/fleet-route-match.js";
import {
  FleetReadInput,
  fleetReadRoutes,
  isFleetReadContract,
  FLEET_PREVIEW_INPUT_BYTES,
} from "../shared/fleet-workspace-api.js";
import {
  FLEET_ACTION_INPUT_BYTES,
  FleetActionInput,
  fleetActionRoutes,
} from "../shared/fleet-workspace-action-api.js";
import { ExecutionRefused } from "./execution-refusal.js";
import { fleetActionInput } from "./fleet-workspace-actions.js";
import type { FleetAuthority } from "./fleet-authority.js";
import type { FleetPeerReads } from "./fleet-peer-reads.js";
import type { FleetPeerActions } from "./fleet-peer-actions.js";
import type { FleetPeerFiles } from "./fleet-peer-files.js";
import type { FleetPeerUploads } from "./fleet-peer-uploads.js";
import type { FleetPeerEvents } from "./fleet-peer-events.js";
import { fleetUploadBody } from "./fleet-upload-body.js";
import { fleetPayloadDigest } from "./fleet-crypto.js";
import {
  FleetFileSelection,
  fleetFileRoutes,
} from "../shared/fleet-workspace-file-api.js";
import { workspaceApi } from "../shared/workspace-api.js";
import { FILE_DOWNLOAD_POLICY, FILE_PREVIEW_POLICY } from "./file-preview.js";

const getRoutes = {
  ...fleetReadRoutes,
  ...fleetFileRoutes,
  artifactDownload: workspaceApi.artifactDownload,
};

function jsonBody(
  req: IncomingMessage,
  signal: AbortSignal,
  limit = FLEET_ACTION_INPUT_BYTES,
): Promise<unknown> {
  const length = Number(req.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > limit)
    throw new ExecutionRefused(413, "This workspace action is too large.");
  if (
    (req.headers["content-type"] ?? "application/json").split(";")[0].trim() !==
      "application/json" ||
    (req.headers["content-encoding"] &&
      req.headers["content-encoding"] !== "identity")
  )
    throw new ExecutionRefused(415, "Choose a JSON workspace action.");
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const clean = () => {
      req.off("data", data);
      req.off("end", end);
      req.off("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const failed = () => {
      clean();
      reject(
        new ExecutionRefused(
          408,
          "The workspace action was not received completely.",
        ),
      );
    };
    const aborted = () => {
      req.pause();
      failed();
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        clean();
        req.pause();
        reject(
          new ExecutionRefused(413, "This workspace action is too large."),
        );
      } else chunks.push(chunk);
    };
    const end = () => {
      clean();
      try {
        resolve(size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(
          new ExecutionRefused(400, "Choose a valid JSON workspace action."),
        );
      }
    };
    req.on("data", data);
    req.once("end", end);
    req.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** The existing source router admits only declared local projections and
 * actions. Owner and destinations come from this Host's services, never from
 * request headers, cookies or a browser-supplied URL. */
export function fleetAgentSource(
  authority: FleetAuthority,
  owner: string,
  reads: FleetPeerReads,
  actions?: FleetPeerActions,
  files?: FleetPeerFiles,
  uploads?: FleetPeerUploads,
  events?: FleetPeerEvents,
): SourceAdapter {
  const uploading = new Map<string, number>();
  let activeUploads = 0;
  return {
    kind: "peer",
    current: (peer) => reads.generation(peer),
    async discover() {
      const local = authority.status(owner),
        document = local.directory?.document;
      if (
        local.state === "removed" ||
        !document ||
        !document.members.some(
          (member) => member.machineId === authority.identity.machineId,
        )
      )
        return [];
      return document.members
        .filter((member) => member.machineId !== authority.identity.machineId)
        .map((member) => ({ id: member.machineId, name: member.name }));
    },
    async events(socket, peer, query) {
      if (events) await events.connect(socket, peer, query);
      else socket.close(1013, "Fleet event subscriptions are unavailable.");
    },
    async proxy(req, res, peer, apiPath, _prefix, current) {
      const controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(45_000),
      ]);
      const cancel = () => controller.abort();
      req.once("aborted", cancel);
      res.once("close", cancel);
      let forwarding = false;
      const reply = (status: number, value: unknown) => {
        current();
        if (res.destroyed) return;
        if (!req.complete) res.setHeader("connection", "close");
        res.writeHead(status, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(value));
      };
      const commandReply = (
        receipt: Awaited<ReturnType<FleetPeerUploads["lookup"]>>,
        status: number,
      ) => {
        res.setHeader("x-loop-command-id", receipt.commandId);
        res.setHeader("x-loop-command-state", receipt.state);
        if (receipt.state === "completed" && receipt.result !== null) {
          reply(status, receipt.result);
        } else if (receipt.state === "refused") {
          reply(409, {
            error:
              "This machine refused the command before execution. Refresh it before trying a new action.",
            executionOutcome: "refused",
          });
        } else {
          reply(503, {
            error:
              receipt.state === "completed"
                ? "This command completed. Refresh the owning machine to see its result. Do not submit it again."
                : "The command outcome is not yet known. Check its original receipt; do not submit a new command.",
            executionOutcome:
              receipt.state === "completed" ? "completed" : "unknown",
          });
        }
      };
      try {
        current();
        if (apiPath.length > 16_384 || apiPath.includes("#"))
          throw new ExecutionRefused(400, "Choose a valid source path.");
        const separator = apiPath.indexOf("?");
        const path =
          "/" + (separator < 0 ? apiPath : apiPath.slice(0, separator));
        const search = new URLSearchParams(
          separator < 0 ? "" : apiPath.slice(separator + 1),
        );
        const method = req.method ?? "GET";
        if (method === "POST" && path === workspaceApi.uploadCreate.path) {
          if (!uploads)
            throw new ExecutionRefused(
              409,
              "This gateway does not support fleet uploads. Open the owning workspace.",
            );
          if (search.size)
            throw new ExecutionRefused(
              400,
              "Uploads do not accept query options.",
            );
          const commandId = z
            .string()
            .uuid()
            .parse(req.headers["x-loop-command-id"]);
          const receiptOnly = req.headers["x-loop-receipt-only"] === "1";
          if (req.headers["x-loop-receipt-only"] !== undefined && !receiptOnly)
            throw new ExecutionRefused(
              400,
              "Choose the original upload or its receipt.",
            );
          if (activeUploads >= 4 || (uploading.get(peer) ?? 0) >= 2)
            throw new ExecutionRefused(
              503,
              "Uploads are busy. Finish an upload and try again.",
            );
          activeUploads++;
          uploading.set(peer, (uploading.get(peer) ?? 0) + 1);
          try {
            const uploadSignal = AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(120_000),
            ]);
            const received = await fleetUploadBody(
              req,
              res,
              uploadSignal,
              current,
              receiptOnly,
            );
            current();
            forwarding = true;
            const receipt = receiptOnly
              ? await uploads.lookup(
                  peer,
                  commandId,
                  fleetPayloadDigest(received.input),
                  current,
                  uploadSignal,
                )
              : await uploads.upload(
                  peer,
                  commandId,
                  received.input,
                  received.bytes!,
                  current,
                  uploadSignal,
                );
            current();
            commandReply(receipt, 201);
          } finally {
            activeUploads--;
            const left = (uploading.get(peer) ?? 1) - 1;
            if (left) uploading.set(peer, left);
            else uploading.delete(peer);
          }
          return;
        }
        if (method === "GET") {
          const route = match(getRoutes, method, path);
          if (route.contract.kind === "stream") {
            if (!files)
              throw new Problem(
                409,
                "This gateway does not support fleet downloads. Update it or open the owning workspace.",
              );
            const query: Record<string, string> = Object.create(null);
            for (const [name, value] of search) {
              if (Object.hasOwn(query, name))
                throw new Problem(400, "Choose each file option once.");
              query[name] = value;
            }
            if (route.name === "artifactDownload" && search.size)
              throw new Problem(
                400,
                "Download links do not accept preview options.",
              );
            const selection = FleetFileSelection.parse({
              route:
                route.name === "artifactDownload" ? "artifactFile" : route.name,
              params: route.params,
              query,
            });
            await files.download(
              peer,
              selection,
              {
                start(file) {
                  current();
                  if (res.destroyed || controller.signal.aborted)
                    throw new Problem(408, "The download was cancelled.");
                  res.statusCode = 200;
                  res.setHeader("Content-Length", file.size);
                  res.setHeader("Content-Type", file.mediaType);
                  res.setHeader("Content-Disposition", file.disposition);
                  res.setHeader("Cache-Control", "private, no-store");
                  res.setHeader("Referrer-Policy", "no-referrer");
                  res.setHeader("X-Content-Type-Options", "nosniff");
                  // Only an explicit HTML preview may run sandboxed scripts.
                  // Never forward a peer's policy or relax ordinary downloads.
                  const htmlPreview =
                    selection.query.preview === "html" &&
                    file.mediaType.split(";", 1)[0].trim().toLowerCase() ===
                      "text/html";
                  res.setHeader(
                    "Content-Security-Policy",
                    htmlPreview ? FILE_PREVIEW_POLICY : FILE_DOWNLOAD_POLICY,
                  );
                },
                async write(bytes) {
                  current();
                  if (res.destroyed || controller.signal.aborted)
                    throw new Problem(408, "The download was cancelled.");
                  if (!res.write(bytes))
                    await new Promise<void>((resolve, reject) => {
                      const clean = () => {
                        res.off("drain", drain);
                        res.off("close", failed);
                        res.off("error", failed);
                        controller.signal.removeEventListener("abort", failed);
                      };
                      const drain = () => {
                        clean();
                        resolve();
                      };
                      const failed = () => {
                        clean();
                        reject(new Problem(408, "The download was cancelled."));
                      };
                      res.once("drain", drain);
                      res.once("close", failed);
                      res.once("error", failed);
                      controller.signal.addEventListener("abort", failed, {
                        once: true,
                      });
                      if (controller.signal.aborted || res.destroyed) failed();
                    });
                  current();
                },
              },
              current,
              controller.signal,
            );
            current();
            res.end();
            return;
          }
        }
        if (method === "GET" || isFleetReadContract({ method, path })) {
          const route = match(fleetReadRoutes, method, path);
          const query: Record<string, string | string[]> = Object.create(null);
          for (const key of new Set(search.keys())) {
            const values = search.getAll(key);
            query[key] = values.length > 1 ? values : values[0];
          }
          const input = FleetReadInput.parse({
            route: route.name,
            params: route.params,
            query,
            ...(method === "GET"
              ? {}
              : {
                  body: route.contract.body.parse(
                    await jsonBody(
                      req,
                      AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
                      FLEET_PREVIEW_INPUT_BYTES,
                    ),
                  ),
                }),
          });
          route.contract.params.parse(input.params);
          route.contract.query.parse(input.query);
          const output = await reads.read(peer, input, signal, current);
          current();
          if (output.clock) {
            res.setHeader("x-loop-change-epoch", output.clock.epoch);
            res.setHeader("x-loop-change-cursor", output.clock.cursor);
            res.setHeader("x-loop-server-now", output.clock.serverNow);
            res.setHeader(
              "x-loop-next-deadline",
              String(output.clock.nextDeadline),
            );
          }
          if (input.route === "capabilities") {
            const catalog = await reads.catalog(peer, signal, current);
            const capabilities = Capabilities.parse(output.result);
            reply(
              200,
              Capabilities.parse({
                ...capabilities,
                pairedDevices: false,
                cardTokens: false,
                continuationStart:
                  !!actions &&
                  catalog.actions.includes("conversationContinueStart"),
                fleet: {
                  version: 1,
                  machineId: peer,
                  reads: catalog.reads.filter((name) =>
                    Object.hasOwn(fleetReadRoutes, name),
                  ),
                  actions: catalog.actions.filter(
                    (name) =>
                      (actions && Object.hasOwn(fleetActionRoutes, name)) ||
                      (uploads && name === "uploadCreate"),
                  ),
                  files: !!files && catalog.files,
                  events: !!events && catalog.events,
                },
              }),
            );
          } else reply(200, output.result);
          return;
        }
        if (!actions)
          throw new ExecutionRefused(
            409,
            "This gateway does not support fleet actions. Update it before continuing.",
          );
        const route = match(fleetActionRoutes, method, path);
        if (search.size)
          throw new ExecutionRefused(
            400,
            "Workspace actions do not accept query parameters.",
          );
        const commandId = z
          .string()
          .uuid()
          .parse(req.headers["x-loop-command-id"]);
        const receiptOnly = req.headers["x-loop-receipt-only"];
        if (receiptOnly !== undefined && receiptOnly !== "1")
          throw new ExecutionRefused(
            400,
            "Choose a valid command receipt request.",
          );
        const body = await jsonBody(
          req,
          AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        );
        current();
        const input = fleetActionInput(
          FleetActionInput.parse({
            route: route.name,
            params: route.params,
            body,
          }),
          commandId,
        );
        forwarding = true;
        const receipt = await actions[receiptOnly ? "receipt" : "action"](
          peer,
          commandId,
          input,
          current,
          signal,
        );
        current();
        // Only a verified destination receipt settles a command. A gateway's
        // failure before its own send cannot exclude an earlier remote effect.
        commandReply(receipt, route.contract.status ?? 200);
      } catch (error) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.removeHeader("content-length");
        res.removeHeader("content-disposition");
        const delay =
          error instanceof Problem ? error.diagnostic?.retryAfterMs : undefined;
        if (typeof delay === "number" && Number.isFinite(delay) && delay > 0)
          res.setHeader(
            "Retry-After",
            String(Math.ceil(Math.min(delay, 300_000) / 1000)),
          );
        // Local validation or lost authorization cannot settle an older send.
        // Only the verified receipt path above may emit a terminal outcome.
        const refused = error instanceof ExecutionRefused || !forwarding;
        // A local identity conflict is a 409, but it cannot settle the original
        // command's outcome. Only a verified receipt carries terminal headers.
        const status =
          error instanceof Problem && error.status === 409
            ? 409
            : refused
              ? error instanceof Problem
                ? error.status
                : 400
              : 503;
        reply(status, {
          error:
            error instanceof Problem
              ? error.message
              : "This source request could not be completed.",
          ...(req.method !== "GET" ? { executionOutcome: "unknown" } : {}),
        });
      } finally {
        req.off("aborted", cancel);
        res.off("close", cancel);
        controller.abort();
      }
    },
  };
}
