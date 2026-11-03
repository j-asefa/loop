import { WebSocket, type ClientOptions } from "ws";
import type { fetch as undiciFetch } from "undici";
import { FleetOrigin } from "../shared/fleet.js";
import { FleetSecret } from "../shared/fleet-credentials.js";
import {
  FLEET_EVENTS_PATH,
  FLEET_EVENT_BYTES,
} from "../shared/fleet-workspace-events.js";
import { Problem } from "../shared/problem.js";
import { safeUrl, publicNetworkLookup } from "./mcp/network.js";
import { FleetWorkspaceHttpTransport } from "./fleet-workspace-http.js";
import type { FleetCapacity } from "./fleet-capacity.js";
import { fleetBackpressure, fleetRetryDelay } from "./fleet-backpressure.js";

export class FleetWorkspaceEventHttpTransport extends FleetWorkspaceHttpTransport {
  constructor(
    fetcher?: typeof undiciFetch,
    private readonly budget?: FleetCapacity,
    private readonly open: (
      url: URL,
      options: ClientOptions & { lookup: typeof publicNetworkLookup },
    ) => WebSocket = (url, options) => new WebSocket(url, options),
  ) {
    super(fetcher, budget);
  }

  /** Only the fixed public machine endpoint receives this server-owned token.
   * The caller verifies a fresh destination nonce before opening the socket. */
  connect(
    origin: string,
    token: string,
    signal: AbortSignal,
  ): Promise<WebSocket> {
    const target = safeUrl(FleetOrigin.parse(origin));
    const credential = FleetSecret.parse(token);
    if (signal.aborted)
      return Promise.reject(
        new Problem(503, "The source connection was cancelled."),
      );
    if (this.budget && !this.budget.connection("outbound"))
      return Promise.reject(
        new Problem(503, "Fleet connection setup is busy."),
      );
    const release = this.budget?.acquireEvent(origin);
    if (this.budget && !release)
      return Promise.reject(fleetBackpressure(this.budget.retryAfter(origin)));
    const url = new URL(FLEET_EVENTS_PATH, target);
    url.protocol = "wss:";
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = this.open(url, {
          headers: {
            authorization: `Bearer ${credential}`,
            "x-loop-fleet-version": "1",
          },
          lookup: publicNetworkLookup,
          followRedirects: false,
          perMessageDeflate: false,
          handshakeTimeout: 10_000,
          maxPayload: FLEET_EVENT_BYTES + 4096,
        });
      } catch {
        release?.();
        reject(new Problem(502, "The source connection is unavailable."));
        return;
      }
      const abort = () => ws.terminate();
      signal.addEventListener("abort", abort, { once: true });
      ws.once("close", () => {
        signal.removeEventListener("abort", abort);
        release?.();
        reject(new Problem(502, "The source connection closed."));
      });
      ws.on("error", () =>
        reject(new Problem(502, "The source connection is unavailable.")),
      );
      ws.once("unexpected-response", (_request, response) => {
        const header = response.headers["retry-after"];
        const milliseconds = fleetRetryDelay(
          typeof header === "string" ? header : null,
        );
        if (response.statusCode === 429 || (response.statusCode ?? 0) >= 500)
          this.budget?.defer(origin, milliseconds);
        reject(
          new Problem(
            response.statusCode &&
              response.statusCode >= 400 &&
              response.statusCode < 500
              ? response.statusCode
              : 503,
            "The source event connection is unavailable.",
            {
              retryAfterMs: milliseconds,
            },
          ),
        );
        response.destroy();
        ws.terminate();
      });
      ws.once("open", () => {
        if (signal.aborted) abort();
        else resolve(ws);
      });
      if (signal.aborted) abort();
    });
  }
}
