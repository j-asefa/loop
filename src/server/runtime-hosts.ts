import * as runtimeHostsQueries from "./sql/runtime-hosts.js";
import * as connectionsQueries from "./sql/connections.js";
import * as mcpConnectionsQueries from "./sql/mcp-connections.js";
import "../../runtime/environment.mjs";
import { workspaceApi } from "../shared/workspace-api.js";
import { registrar, projectResponse } from "./registrar.js";
import { companionMode } from "./profile.js";

import { z } from "zod";
import { db, id, now } from "./db.js";
import { owned, ownedRuntimeHost, Problem } from "./domain.js";
import { seal, unseal } from "./secrets.js";
import {
  safeUrl,
  safeRuntimeFetch,
  publicNetworkDispatcher,
} from "./mcp/network.js";
import { codexStatus } from "./codex-app-server.js";
import type { Dispatcher } from "undici";
export type RuntimeEndpoint = {
  kind: "broker" | "codex-app-server" | "native-host" | "local";
  url: string;
  token: string;
  fetch: typeof fetch;
  dispatcher?: Dispatcher;
};
const kindOf = (url: string): RuntimeEndpoint["kind"] =>
  /^wss?:/.test(url) ? "codex-app-server" : "broker";
const allowed = () =>
  (process.env.LOOP55_ALLOWED_RUNTIME_ORIGINS || "")
    .split(",")
    .map((s) => s.trim());
function validate(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["https:", "http:", "wss:", "ws:"].includes(url.protocol)
  )
    throw new Problem(
      400,
      "Use a runtime URL without credentials, query or fragment",
    );
  if (!allowed().includes(url.origin)) {
    const address = new URL(url);
    if (address.protocol === "wss:") address.protocol = "https:";
    if (address.protocol === "ws:") address.protocol = "http:";
    safeUrl(address);
  }
  return url.href.replace(/\/$/, "");
}
export function runtimeEndpoint(
  owner: string,
  hostId?: string,
  service: "broker" | "codex" | "claude" = "broker",
): RuntimeEndpoint {
  if (companionMode) {
    if (hostId && hostId !== "local")
      throw new Problem(
        422,
        "Companion runtime processes run on this computer.",
      );
    return { kind: "local", url: "", token: "", fetch };
  }
  if (!hostId) {
    if (
      !process.env.LOOP55_RUNTIME_URL ||
      (process.env.LOOP55_RUNTIME_TOKEN?.length || 0) < 32
    )
      throw new Problem(
        503,
        "Configure a runtime machine in Settings or start the supplied Docker Compose services.",
      );
    return {
      kind: "broker",
      url: process.env.LOOP55_RUNTIME_URL.replace(/\/$/, ""),
      token: process.env.LOOP55_RUNTIME_TOKEN!,
      fetch,
    };
  }
  const host = ownedRuntimeHost(hostId, owner),
    url = validate(host.url);
  const kind = host.kind as RuntimeEndpoint["kind"];
  if (kind === "codex-app-server" && service !== "codex")
    throw new Problem(
      400,
      "This machine only runs Codex agents. Choose a Loop55 runtime broker for Claude or command-based MCP servers.",
    );
  if (kind === "native-host" && service === "broker")
    throw new Problem(
      400,
      "Choose a Loop55 runtime broker to install workspace MCPs. Native host MCPs are managed in Codex or Claude Code.",
    );
  const privateOrigin = allowed().includes(new URL(url).origin);
  return {
    kind,
    url,
    token: unseal(host.secret, owner),
    fetch: privateOrigin ? fetch : safeRuntimeFetch,
    dispatcher: privateOrigin ? undefined : publicNetworkDispatcher,
  };
}
const routes = registrar("runtimeHosts", {
  middleware: [
    [
      "/runtime-hosts",
      (req, res, next) => {
        if (!companionMode) return next();
        if (req.method === "GET" && req.path === "/") return next();
        if (req.method === "GET")
          return res.json(
            projectResponse(workspaceApi.runtimeHostList, [
              { id: "local", name: "This computer", kind: "local", url: "" },
            ]),
          );
        throw new Problem(
          409,
          "Remote runtime management requires the server profile.",
        );
      },
    ],
  ],
});
export const runtimeHosts = routes.mount;

routes.on(workspaceApi.runtimeHostList, (_req, res) =>
  res.json(
    companionMode
      ? [{ id: "local", name: "This computer", kind: "local", url: "" }]
      : (runtimeHostsQueries.publicList(db, res.locals.owner) as z.input<
          typeof workspaceApi.runtimeHostList.response
        >),
  ),
);
routes.on(workspaceApi.runtimeHostCreate, async (req, res) => {
  const d = req.body;
  const url = validate(d.url);
  if ((kindOf(url) === "codex-app-server") !== (d.kind === "codex-app-server"))
    throw new Problem(
      400,
      d.kind === "codex-app-server"
        ? "Use a ws:// or wss:// address for Codex app-server."
        : "Use an http:// or https:// address for a Loop55 runtime broker.",
    );
  const fetcher = allowed().includes(new URL(url).origin)
    ? fetch
    : safeRuntimeFetch;
  try {
    if (d.kind === "codex-app-server") {
      await codexStatus({
        url,
        token: d.token,
        dispatcher: allowed().includes(new URL(url).origin)
          ? undefined
          : publicNetworkDispatcher,
      });
    } else {
      const r = await fetcher(url + "/health", {
        headers: { authorization: "Bearer " + d.token },
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (!r.ok) throw new Error("Unavailable");
      const health = await r.json();
      if (!health.ok || (health.kind || "broker") !== d.kind)
        throw new Problem(
          422,
          "The machine does not match the selected connection type. Check how its runtime was started.",
        );
    }
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(
      422,
      "Could not connect to this runtime. Check its address and access token.",
    );
  }
  const host = id();
  runtimeHostsQueries.insert(
    db,
    host,
    res.locals.owner,
    d.name,
    url,
    seal(d.token, res.locals.owner),
    now(),
    d.kind,
  );
  res.status(201).json({ id: host, name: d.name, url, kind: d.kind });
});
routes.on(workspaceApi.runtimeHostDelete, (req, res) => {
  owned("runtime_hosts", req.params.id, res.locals.owner);
  if (
    connectionsQueries.runtimeHostInUse(db, res.locals.owner, req.params.id) ||
    mcpConnectionsQueries.runtimeHostInUse(db, res.locals.owner, req.params.id)
  )
    throw new Problem(
      409,
      "Disconnect accounts and tools using this machine first",
    );
  runtimeHostsQueries.remove(db, req.params.id, res.locals.owner);
  res.json({ ok: true });
});
