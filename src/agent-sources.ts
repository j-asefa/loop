import type { IncomingMessage, ServerResponse } from "node:http";
import {
  linkedDockerWorkspaces,
  proxyLinkedDocker,
  connectLinkedDockerEvents,
} from "./linked-docker.js";
import type { WebSocket } from "ws";

/** An owner-visible Loop55 API that holds agents and their conversations. */
export type AgentSource = { id: string; name: string; kind: string };

export type SourceAdapter = {
  kind: string;
  discover: () => Promise<{ id: string; name: string }[]>;
  events: (
    socket: WebSocket,
    resourceId: string,
    query: URLSearchParams,
  ) => Promise<void>;
  proxy: (
    req: IncomingMessage,
    res: ServerResponse,
    resourceId: string,
    apiPath: string,
    responsePrefix: string,
    current: () => void,
  ) => Promise<void>;
};

// Docker discovery admits server profiles only. Independently enrolled Docker
// companions therefore appear solely through the peer adapter, never twice.
export const dockerSourceAdapter: SourceAdapter = {
  kind: "docker",
  discover: linkedDockerWorkspaces,
  events: connectLinkedDockerEvents,
  proxy: proxyLinkedDocker,
};

/** Each Host owns its adapters. An owner's peer service must never be installed
 * in a process-global registry that another workspace could discover or use.
 * Opaque IDs select registered resources, never a browser-supplied network URL. */
export class AgentSources {
  private readonly adapters = new Map<string, SourceAdapter>();
  constructor(adapters: readonly SourceAdapter[] = [dockerSourceAdapter]) {
    for (const adapter of adapters) {
      if (
        !/^[a-z][a-z0-9-]{0,31}$/.test(adapter.kind) ||
        this.adapters.has(adapter.kind)
      )
        throw new Error("Source adapter kinds must be valid and unique");
      this.adapters.set(adapter.kind, { ...adapter });
    }
  }
  private source(id: string) {
    const match = /^([a-z][a-z0-9-]{0,31}):([a-zA-Z0-9._~-]{1,128})$/.exec(id);
    const adapter = match ? this.adapters.get(match[1]) : undefined;
    return match && adapter ? { adapter, resource: match[2] } : undefined;
  }
  async discover(): Promise<AgentSource[]> {
    const discovered = await Promise.allSettled(
      [...this.adapters.values()].map(async (adapter) =>
        (await adapter.discover())
          .filter(
            ({ id, name }) =>
              /^[a-zA-Z0-9._~-]{1,128}$/.test(id) &&
              typeof name === "string" &&
              !!name.trim(),
          )
          .map(({ id, name }) => ({
            id: `${adapter.kind}:${id}`,
            name,
            kind: adapter.kind,
          })),
      ),
    );
    return discovered.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
  }
  async events(socket: WebSocket, id: string, query: URLSearchParams) {
    const source = this.source(id);
    if (!source) {
      socket.close(1008, "Execution source unavailable");
      return;
    }
    await source.adapter.events(socket, source.resource, query);
  }
  async proxy(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    apiPath: string,
    current: () => void,
  ) {
    current();
    const source = this.source(id);
    if (source) {
      await source.adapter.proxy(
        req,
        res,
        source.resource,
        apiPath,
        `/api/agent-sources/${encodeURIComponent(id)}/`,
        current,
      );
      return;
    }
    res.writeHead(404, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ error: "Execution source unavailable." }));
  }
}
