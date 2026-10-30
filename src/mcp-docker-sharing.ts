import { linkedDockerWorkspaces } from "./linked-docker.js";
import { db } from "./server/db.js";
import { Problem } from "./server/domain.js";
import { OWNER } from "./server/native-sessions.js";
import { hostEnvironmentName } from "./server/execution-location.js";
import {
  enrollFederationPeer,
  FEDERATION_SETUP_HEADER,
  installFederationPeer,
  invokeLocalFederatedTool,
  localFederationCatalog,
  revokeFederationPeer,
} from "./server/mcp/federation.js";
import { discover, type MCPConnection } from "./server/mcp/client.js";
import { ToolBudgetError } from "./server/mcp/tool-budget.js";

type DockerSource = { id: string; name: string; port: number };
type PendingCall = {
  id: string;
  runKey: string;
  requestKey: string;
  name: string;
  args: string;
};

// All requests leave the laptop for a loopback-published, discovered Docker
// server. No host listener or provider credential is opened to the container.
export class DockerMcpSharing {
  private timer?: NodeJS.Timeout;
  private serving = new Set<string>();
  private revocationRetryAt = 0;
  private refreshed = new Map<string, number>();

  start() {
    this.timer = setInterval(() => void this.poll(), 3000);
    this.timer.unref();
  }
  close() {
    if (this.timer) clearInterval(this.timer);
  }

  private connectedIds() {
    const rows = db
      .prepare(
        `SELECT json_extract(metadata,'$.federatedPeer') AS peer
         FROM mcp_connections WHERE owner_id=? AND status='connected'
         AND json_extract(metadata,'$.transport')='federation'
         AND json_extract(metadata,'$.federatedPeer') LIKE 'docker:%'`,
      )
      .all(OWNER) as { peer: string }[];
    return new Set(rows.map((row) => row.peer));
  }
  private pendingRevocations() {
    return new Set(
      (
        db
          .prepare(
            "SELECT peer_id FROM mcp_federation_peers WHERE owner_id=? AND peer_id LIKE 'docker:%' AND revoked_at IS NOT NULL AND revoke_synced_at IS NULL",
          )
          .all(OWNER) as { peer_id: string }[]
      ).map((row) => row.peer_id),
    );
  }

  async status() {
    const connected = this.connectedIds();
    return (await linkedDockerWorkspaces()).map((source) => ({
      id: `docker:${source.id}`,
      name: source.name,
      shared: connected.has(`docker:${source.id}`),
    }));
  }

  private async source(sourceId: string): Promise<DockerSource> {
    const source = (await linkedDockerWorkspaces(true)).find(
      (item) => `docker:${item.id}` === sourceId,
    );
    if (!source) throw new Problem(404, "Docker execution source unavailable");
    return source;
  }

  private async request<T>(
    source: DockerSource,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const origin = `http://127.0.0.1:${source.port}`;
    const response = await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin,
        [FEDERATION_SETUP_HEADER]: "1",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Problem(
        response.status === 404 ? 409 : 502,
        response.status === 404
          ? "Update this Docker Loop55 server to share its MCP tools."
          : "Docker tool sharing is unavailable. Try again when the source is running.",
      );
    return (await response.json()) as T;
  }

  async connect(sourceId: string) {
    const source = await this.source(sourceId);
    // A previous Stop sharing may have been recorded while Docker was down.
    // Finish that revocation before issuing a new token for the same peer.
    if (this.pendingRevocations().has(sourceId))
      await this.syncRevocation(source);
    const origin = `http://127.0.0.1:${source.port}`;
    const peerId = `laptop:${OWNER}`;
    // This enrollment runs only after the paired user presses Share tools.
    const enrolled = await this.request<{ token: string }>(
      source,
      "/api/mcp/federation/enroll",
      { peerId },
    );
    await installFederationPeer(
      OWNER,
      sourceId,
      source.name,
      origin + "/api/mcp/federation",
      enrolled.token,
    );
    enrollFederationPeer(OWNER, sourceId);
    await this.request(source, "/api/mcp/federation/import-reverse", {
      peerId,
      label: hostEnvironmentName().slice(0, 80),
      tools: localFederationCatalog(OWNER),
    });
    return { id: sourceId, shared: true };
  }
  async disconnect(sourceId: string) {
    if (!/^docker:[a-f0-9]{64}$/.test(sourceId))
      throw new Problem(400, "Invalid Docker execution source");
    revokeFederationPeer(OWNER, sourceId);
    const source = (await linkedDockerWorkspaces(true)).find(
      (item) => `docker:${item.id}` === sourceId,
    );
    if (source) await this.syncRevocation(source).catch(() => {});
    return { id: sourceId, shared: false };
  }

  private async syncRevocation(source: DockerSource) {
    const sourceId = `docker:${source.id}`;
    await this.request(source, "/api/mcp/federation/revoke", {
      peerId: `laptop:${OWNER}`,
    });
    db.prepare(
      "UPDATE mcp_federation_peers SET revoke_synced_at=? WHERE owner_id=? AND peer_id=? AND revoked_at IS NOT NULL",
    ).run(Date.now(), OWNER, sourceId);
  }

  async refresh(source: DockerSource) {
    const sourceId = `docker:${source.id}`;
    const connection = db
      .prepare(
        "SELECT * FROM mcp_connections WHERE owner_id=? AND status='connected' AND json_extract(metadata,'$.federatedPeer')=?",
      )
      .get(OWNER, sourceId) as MCPConnection | undefined;
    if (!connection) return;
    await discover(connection, { keepOnBudget: true }).catch((error) => {
      // Keep publishing laptop changes, and keep sharing with the previous
      // catalog, when Docker's is temporarily unavailable or would exceed
      // the tool budget. Disabling here would silently stop sharing.
      if (error instanceof ToolBudgetError)
        console.warn(
          `[sharing] ${source.name}'s tools exceed the tool budget; keeping its previous catalog.`,
        );
    });
    await this.request(source, "/api/mcp/federation/import-reverse", {
      peerId: `laptop:${OWNER}`,
      label: hostEnvironmentName().slice(0, 80),
      tools: localFederationCatalog(OWNER),
    });
  }

  private async poll() {
    const connected = this.connectedIds();
    const revocations = this.pendingRevocations();
    if (!connected.size && !revocations.size) return;
    // A revocation for a source that is not running cannot sync yet. Look
    // for it every few minutes instead of running docker every poll.
    if (!connected.size && Date.now() < this.revocationRetryAt) return;
    const sources = await linkedDockerWorkspaces();
    const found = new Set(sources.map((source) => `docker:${source.id}`));
    this.revocationRetryAt =
      connected.size || [...revocations].some((id) => found.has(id))
        ? 0
        : Date.now() + 5 * 60_000;
    // Each source is served independently, so a slow tool on one source
    // never delays another source's calls into a timeout.
    await Promise.all(
      sources.map((source) => {
        const sourceId = `docker:${source.id}`;
        if (this.serving.has(sourceId)) return;
        if (!revocations.has(sourceId) && !connected.has(sourceId)) return;
        this.serving.add(sourceId);
        return this.serve(source, revocations.has(sourceId)).finally(() =>
          this.serving.delete(sourceId),
        );
      }),
    );
  }

  private async serve(source: DockerSource, revoking: boolean) {
    const sourceId = `docker:${source.id}`;
    const peerId = `laptop:${OWNER}`;
    if (revoking) {
      await this.syncRevocation(source).catch(() => {});
      return;
    }
    try {
      if (Date.now() - (this.refreshed.get(sourceId) || 0) > 60_000) {
        try {
          await this.refresh(source);
          this.refreshed.set(sourceId, Date.now());
        } catch {
          // Catalog refresh does not prevent an already queued tool call
          // from receiving its one durable answer.
        }
      }
      const pending = await this.request<PendingCall[]>(
        source,
        `/api/mcp/federation/pending?peerId=${encodeURIComponent(peerId)}`,
      );
      for (const item of pending) {
        // Claim right before running: Docker refuses a call it has already
        // reported as uncertain, so that effect is never sent afterwards.
        const { claimed } = await this.request<{ claimed: boolean }>(
          source,
          `/api/mcp/federation/claim/${item.id}`,
          { peerId },
        );
        if (!claimed) continue;
        let state: "completed" | "unknown" = "unknown";
        let result: unknown;
        try {
          result = await invokeLocalFederatedTool(
            OWNER,
            sourceId,
            item.runKey,
            item.requestKey,
            item.name,
            JSON.parse(item.args),
          );
          state = "completed";
        } catch {
          // The source stores uncertain effects durably. A later poll can
          // report unknown, but it must never send the tool again.
        }
        await this.request(source, `/api/mcp/federation/complete/${item.id}`, {
          peerId,
          state,
          result,
        });
      }
    } catch {
      // Reconnect is explicit. A transient failure is retried on the next
      // poll, while any call already executing remains generation-bound.
    }
  }
}
