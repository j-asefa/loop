import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { SourceAdapter } from "../agent-sources.js";
import { Problem } from "../shared/problem.js";
import { Capabilities } from "../shared/capabilities.js";
import { matchFleetRoute as match } from "../shared/fleet-route-match.js";
import {
  FleetReadInput,
  fleetReadRoutes,
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

function jsonBody(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const length = Number(req.headers["content-length"] ?? 0);
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > FLEET_ACTION_INPUT_BYTES
  )
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
      if (size > FLEET_ACTION_INPUT_BYTES) {
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
 * request headers, cookies or a browser-supplied URL. Still opt-in until the
 * browser command journal and complete capability UI are wired. */
export function fleetAgentSource(
  authority: FleetAuthority,
  owner: string,
  reads: FleetPeerReads,
  actions?: FleetPeerActions,
): SourceAdapter {
  return {
    kind: "peer",
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
    async events(socket) {
      socket.close(1013, "Fleet event subscriptions are unavailable.");
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
        if (method === "GET") {
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
                runtimeHosts: false,
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
                  actions: actions
                    ? catalog.actions.filter((name) =>
                        Object.hasOwn(fleetActionRoutes, name),
                      )
                    : [],
                  files: catalog.files,
                  events: catalog.events,
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
        res.setHeader("x-loop-command-id", receipt.commandId);
        res.setHeader("x-loop-command-state", receipt.state);
        if (receipt.state === "completed" && receipt.result !== null) {
          reply(route.contract.status ?? 200, receipt.result);
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
      } catch (error) {
        // Local validation or lost authorization cannot settle an older send.
        // Only the verified receipt path above may emit a terminal outcome.
        const refused = error instanceof ExecutionRefused || !forwarding;
        reply(refused ? (error instanceof Problem ? error.status : 400) : 503, {
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
