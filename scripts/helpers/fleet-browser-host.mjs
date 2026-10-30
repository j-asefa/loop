import "../../runtime/environment.mjs";
// Isolated compiled companion used only by the fleet browser fixture. All peer
// packets still cross the production Host/protocol handlers. This injected
// loopback transport is not evidence of Internet DNS, TLS or tunnel behavior.
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { Response } from "undici";
import { resolve } from "node:path";
const { WorkspaceHost } = await import("../../dist/workspace-host.js");
const { db } = await import("../../dist/server/db.js");
const options = {
  harness: "codex",
  version: "fixture",
  project: process.env.FLEET_FIXTURE_PROJECT,
  executable: resolve("test/harness.mjs"),
  billing: "existing",
};
const host = new WorkspaceHost(process.env.LOOP55_DATA_DIR, options);
// Hold the real HTTP response at the fixture edge so the late-response case
// follows the same path in both browser engines, including service workers.
let mintGate,
  deliveriesGate,
  failStatus = false,
  statusReads = 0;
const adminHttp = host.gateway.workspace.fleetAdminHttp;
host.gateway.workspace.fleetAdminHttp = (req, res) => {
  if (req.url === "/api/fleet/admin/state") {
    statusReads++;
    if (failStatus) {
      res.writeHead(503, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ error: "Fixture unavailable" }));
      return;
    }
  }
  if (mintGate && req.url === "/api/fleet/admin/enrollment-link") {
    const gate = mintGate;
    const end = res.end;
    res.end = function (...args) {
      gate.seen = true;
      gate.release = () => {
        res.end = end;
        if (!res.destroyed) end.apply(res, args);
      };
      return res;
    };
  }
  if (deliveriesGate && req.url === "/api/fleet/admin/deliveries") {
    const gate = deliveriesGate;
    const end = res.end;
    res.end = function (...args) {
      gate.releases.push(() => {
        res.end = end;
        if (!res.destroyed) end.apply(res, args);
      });
      return res;
    };
  }
  adminHttp(req, res);
};
const fetcher = async (input, init) => {
  const url = new URL(input);
  const mapping = JSON.parse(
    await readFile(process.env.FLEET_FIXTURE_MAP, "utf8"),
  );
  const port = mapping[url.origin];
  if (!port) throw new Error("Fixture peer is unavailable");
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: url.pathname,
        method: init.method,
        signal: init.signal,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          host: url.host,
        },
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024)
            res.destroy(new Error("Fixture packet too large"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode,
              headers: { "content-type": res.headers["content-type"] ?? "" },
            }),
          ),
        );
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
};
for (const service of [
  host.fleetAdmin.source,
  host.fleetAdmin.handoff,
  host.fleetDistribution,
  host.fleetReconcile,
  host.fleetLeases,
]) {
  if (service?.transport) service.transport.fetcher = fetcher;
}
let stopping = false;
process.on("SIGTERM", async () => {
  if (stopping) return;
  stopping = true;
  try {
    await host.close();
    db.close();
  } finally {
    process.exit(0);
  }
});
await host.start(options);
host.gateway.setOrigin(process.env.FLEET_FIXTURE_ORIGIN);
process.send({ ready: true, port: host.gateway.port });
process.on("message", async ({ id, method, value }) => {
  try {
    let result;
    if (method === "pair") result = host.pair();
    else if (method === "state") result = host.fleetAdmin.state();
    else if (method === "deliveries") result = host.fleetAdmin.deliveries(null);
    else if (method === "seedDeliveryPages") {
      const { head } = host.fleetAdmin.state();
      const { owner_id: owner } = db
        .prepare("SELECT owner_id FROM fleet_binding WHERE head=?")
        .get(head);
      const insert = db.prepare(
        "INSERT INTO fleet_distribution(owner_id,peer_id,directory_digest,state,next_attempt) VALUES(?,?,?,?,?)",
      );
      let last;
      db.transaction(() => {
        for (let i = 0; i < 51; i++) {
          last = "m_" + "f".repeat(60) + i.toString(16).padStart(4, "0");
          insert.run(
            owner,
            last,
            head,
            i === 50 ? "pending" : "acked",
            Number.MAX_SAFE_INTEGER,
          );
        }
      })();
      result = last;
    } else if (method === "ackDelivery") {
      const { head } = host.fleetAdmin.state();
      db.prepare(
        "UPDATE fleet_distribution SET state='acked' WHERE directory_digest=? AND peer_id=?",
      ).run(head, value);
      result = true;
    } else if (method === "holdDeliveries") {
      deliveriesGate = { releases: [] };
      result = true;
    } else if (method === "deliveriesHeld")
      result = deliveriesGate?.releases.length ?? 0;
    else if (method === "releaseDeliveries") {
      const gate = deliveriesGate;
      deliveriesGate = undefined;
      for (const release of gate?.releases ?? []) release();
      result = true;
    } else if (method === "failStatus") {
      failStatus = !!value;
      result = true;
    } else if (method === "statusReads") result = statusReads;
    else if (method === "holdMint") {
      mintGate = { seen: false };
      result = true;
    } else if (method === "mintReady") result = !!mintGate?.seen;
    else if (method === "releaseMint") {
      mintGate?.release?.();
      mintGate = undefined;
      result = true;
    } else if (method === "origin") {
      host.gateway.setOrigin(value);
      result = true;
    } else if (method === "close") {
      await host.close();
      db.close();
      process.send({ id, result: true });
      process.exit(0);
    } else throw new Error("Unknown fixture command");
    process.send({ id, result });
  } catch {
    process.send({ id, error: "Fixture command failed" });
  }
});
