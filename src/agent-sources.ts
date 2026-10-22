import type { IncomingMessage, ServerResponse } from "node:http";
import {
  linkedDockerWorkspaces,
  proxyLinkedDocker,
  connectLinkedDockerEvents,
} from "./linked-docker.js";
import type { WebSocket } from "ws";

/** An owner-visible Loop API that holds agents and their conversations. */
export type AgentSource = { id: string; name: string; kind: string };

type SourceAdapter = {
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
  ) => Promise<void>;
};

const adapters: SourceAdapter[] = [
  {
    kind: "docker",
    discover: linkedDockerWorkspaces,
    events: connectLinkedDockerEvents,
    proxy: proxyLinkedDocker,
  },
];

export async function connectAgentSourceEvents(
  socket: WebSocket,
  id: string,
  query: URLSearchParams,
) {
  const match = /^([a-z][a-z0-9-]{0,31}):([a-zA-Z0-9._~-]{1,128})$/.exec(id);
  const adapter = adapters.find((item) => item.kind === match?.[1]);
  if (!match || !adapter) {
    socket.close(1008, "Execution source unavailable");
    return;
  }
  await adapter.events(socket, match[2], query);
}

// Source IDs are opaque to the browser. Each adapter resolves only resources
// it discovered or registered itself; adding another host type does not give
// the browser a way to nominate an arbitrary network destination.
export async function agentSources(): Promise<AgentSource[]> {
  const discovered = await Promise.all(
    adapters.map(async (adapter) =>
      (await adapter.discover()).map(({ id, name }) => ({
        id: `${adapter.kind}:${id}`,
        name,
        kind: adapter.kind,
      })),
    ),
  );
  return discovered.flat();
}

export async function proxyAgentSource(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  apiPath: string,
) {
  const match = /^([a-z][a-z0-9-]{0,31}):([a-zA-Z0-9._~-]{1,128})$/.exec(id);
  const adapter = adapters.find((item) => item.kind === match?.[1]);
  if (adapter && match) {
    await adapter.proxy(
      req,
      res,
      match[2],
      apiPath,
      `/api/agent-sources/${encodeURIComponent(id)}/`,
    );
    return;
  }
  res.writeHead(404, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ error: "Execution source unavailable." }));
}
