import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { routePath } from "../shared/route-path.js";
import { Problem } from "../shared/problem.js";
import { WorkspaceClock } from "../shared/workspace-events.js";
import {
  FleetReadInput,
  fleetReadRoutes,
  FLEET_READ_RESPONSE_BYTES,
} from "../shared/fleet-workspace-api.js";
import { bindRouteLifecycle, projectResponse } from "./registrar.js";
import type { RouteContract } from "../shared/workspace-api.js";
import {
  FleetActionInput,
  fleetActionRoutes,
} from "../shared/fleet-workspace-action-api.js";
import { ExecutionRefused } from "./execution-refusal.js";
import { withPassiveWorkspaceRead } from "./workspace-read-context.js";
import {
  FleetFileSelection,
  fleetFileRoutes,
  FLEET_FILE_BYTES,
} from "../shared/fleet-workspace-file-api.js";

type WorkspaceInput = {
  params: Record<string, string | number>;
  query: Record<string, unknown>;
  body?: unknown;
};
type WorkspaceResult = { result: unknown; clock?: WorkspaceClock };
export type FleetWorkspaceFileContent = {
  bytes: Buffer;
  mediaType: string;
  disposition: string;
};

/** Invoke the existing companion application's declared local route through a
 * bounded in-memory HTTP connection. It opens no listener and accepts neither
 * an arbitrary URL nor request headers. All of the application's existing
 * route middleware, projections and owner checks still execute. Only a fleet
 * service with a verified local-owner grant may use this bridge; mutations also
 * carry the internal action context checked at handler and effect boundaries. */
export class FleetWorkspaceApp {
  private readonly pending = { read: 0, action: 0 };
  constructor(
    private readonly app: (req: IncomingMessage, res: ServerResponse) => void,
    private readonly owner: string,
  ) {}

  read(owner: string, input: FleetReadInput, authorize: () => void) {
    const value = FleetReadInput.parse(input);
    const contract: RouteContract = fleetReadRoutes[value.route];
    return withPassiveWorkspaceRead(owner, () =>
      this.request(owner, contract, value, authorize, false),
    );
  }

  action(owner: string, input: FleetActionInput, authorize: () => void) {
    const value = FleetActionInput.parse(input);
    return this.request(
      owner,
      fleetActionRoutes[value.route],
      { ...value, query: {} },
      authorize,
      true,
    );
  }

  file(
    owner: string,
    input: FleetFileSelection,
    authorize: () => void,
    signal?: AbortSignal,
  ) {
    const value = FleetFileSelection.parse(input);
    const contract = fleetFileRoutes[value.route];
    contract.params.parse(value.params);
    contract.query.parse(value.query);
    return this.request(owner, contract, value, authorize, false, true, signal);
  }

  private request(
    owner: string,
    contract: RouteContract,
    input: WorkspaceInput,
    authorize: () => void,
    mutation: boolean,
    file: true,
    signal?: AbortSignal,
  ): Promise<FleetWorkspaceFileContent>;
  private request(
    owner: string,
    contract: RouteContract,
    input: WorkspaceInput,
    authorize: () => void,
    mutation: boolean,
    file?: false,
  ): Promise<WorkspaceResult>;

  private request(
    owner: string,
    contract: RouteContract,
    input: WorkspaceInput,
    authorize: () => void,
    mutation: boolean,
    file = false,
    signal?: AbortSignal,
  ) {
    if (owner !== this.owner)
      throw new ExecutionRefused(
        403,
        "The fleet grant does not own this workspace.",
      );
    const path = "/api" + routePath(contract, input);
    const body =
      contract.method === "GET"
        ? undefined
        : JSON.stringify(input.body ?? null);
    authorize();
    const limit = file ? FLEET_FILE_BYTES : FLEET_READ_RESPONSE_BYTES;
    const kind = mutation ? "action" : "read";
    if (this.pending[kind] >= 4)
      throw new ExecutionRefused(
        503,
        "The remote workspace is busy. Retry later.",
      );
    this.pending[kind]++;
    return new Promise<WorkspaceResult | FleetWorkspaceFileContent>(
      (resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0,
          settled = false;
        let started = false,
          released = false;
        const release = () => {
          if (released) return;
          released = true;
          this.pending[kind]--;
        };
        const sink = new Duplex({
          read() {},
          write(chunk, _encoding, done) {
            size += chunk.length;
            if (size > limit + 32 * 1024) {
              done(new Error("Workspace projection exceeded its limit"));
            } else {
              chunks.push(Buffer.from(chunk));
              done();
            }
          },
        });
        // Node uses Socket's stream interface here; no network socket is opened.
        const socket = sink as Socket;
        const req = new IncomingMessage(socket);
        bindRouteLifecycle(req, {
          start: () => {
            if (settled)
              throw new ExecutionRefused(
                504,
                "The workspace request expired before dispatch.",
              );
            started = true;
          },
          finish: release,
        });
        req.method = contract.method;
        req.url = path;
        req.headers = {
          host: "loop55.internal.invalid",
          accept: file ? "*/*" : "application/json",
          connection: "close",
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(body)),
              }),
        };
        req.httpVersion = "1.1";
        req.httpVersionMajor = 1;
        req.httpVersionMinor = 1;
        req.complete = true;
        const res = new ServerResponse(req);
        res.shouldKeepAlive = false;
        res.useChunkedEncodingByDefault = false;
        res.assignSocket(socket);
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            if (error) throw error;
            // A post-effect refusal cannot certify that a mutation was never
            // dispatched. Its destination receipt is saved before the action
            // service rechecks whether it may return the result to this peer.
            if (!mutation) authorize();
            if (
              (!file &&
                !/^application\/json(?:\s*;|$)/i.test(
                  String(res.getHeader("content-type") ?? ""),
                )) ||
              res.hasHeader("transfer-encoding")
            )
              throw new Error("Unexpected workspace projection");
            const bytes = Buffer.concat(chunks, size);
            const start = bytes.indexOf("\r\n\r\n");
            if (
              start < 0 ||
              start > 32 * 1024 ||
              bytes.length - start - 4 > limit
            )
              throw new Error("Invalid workspace projection");
            const parsed = file
              ? undefined
              : JSON.parse(bytes.subarray(start + 4).toString("utf8"));
            if (
              ![
                contract.status ?? 200,
                ...(contract.additionalStatuses ?? []),
              ].includes(res.statusCode)
            ) {
              const status =
                res.statusCode >= 400 && res.statusCode < 500
                  ? res.statusCode
                  : 502;
              if (mutation && parsed?.executionOutcome === "refused")
                throw new ExecutionRefused(
                  status,
                  "The workspace refused this action before dispatch.",
                );
              throw new Problem(
                status,
                "The remote workspace item is unavailable.",
              );
            }
            if (file) {
              resolve({
                bytes: Buffer.from(bytes.subarray(start + 4)),
                mediaType: String(
                  res.getHeader("content-type") ?? "application/octet-stream",
                ),
                disposition: String(
                  res.getHeader("content-disposition") ?? "attachment",
                ),
              });
              return;
            }
            const result = projectResponse(contract, parsed);
            const epoch = res.getHeader("x-loop55-change-epoch");
            const clock =
              epoch === undefined
                ? undefined
                : WorkspaceClock.parse({
                    epoch,
                    cursor: Number(res.getHeader("x-loop55-change-cursor")),
                    serverNow: Number(res.getHeader("x-loop55-server-now")),
                    nextDeadline:
                      res.getHeader("x-loop55-next-deadline") === "null"
                        ? null
                        : Number(res.getHeader("x-loop55-next-deadline")),
                  });
            resolve({ result, ...(clock ? { clock } : {}) });
          } catch (error) {
            reject(
              error instanceof Problem
                ? error
                : new Problem(
                    502,
                    "The remote workspace response is unavailable.",
                  ),
            );
          } finally {
            signal?.removeEventListener("abort", aborted);
            // An async handler may outlive this HTTP response. Its registrar
            // releases capacity only when the handler has actually settled.
            if (!started) release();
            chunks.length = 0;
            req.destroy();
            res.destroy();
            sink.destroy();
          }
        };
        const timer = setTimeout(
          () =>
            finish(new Problem(504, "The remote workspace request timed out.")),
          12_000,
        );
        timer.unref();
        const aborted = () =>
          finish(new Problem(408, "The file request was cancelled."));
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) {
          aborted();
          return;
        }
        sink.once("error", finish);
        req.once("error", finish);
        res.once("error", finish);
        res.once("close", () => {
          if (!res.writableFinished) finish(new Error("Workspace read closed"));
        });
        res.once("finish", () => finish());
        if (body !== undefined) req.push(body);
        req.push(null);
        try {
          this.app(req, res);
        } catch (error) {
          finish(error);
        }
      },
    );
  }
}
