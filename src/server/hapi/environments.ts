import { readFileSync } from "node:fs";
import { Agent, fetch as secureFetch } from "undici";
import { db, id, now } from "../db.js";
import { owned, Problem } from "../domain.js";
import { seal, unseal } from "../secrets.js";
import { digest } from "./contracts.js";
import { HapiClient } from "./client.js";
import { MAX_CONCURRENT_RUNS } from "../../../runtime/concurrency.mjs";

export function environment(owner: string, hostId: string): any {
  const h = owned<any>("runtime_hosts", hostId, owner);
  const e = db
    .prepare(
      "SELECT * FROM execution_environments WHERE host_id=? AND owner_id=?",
    )
    .get(hostId, owner) as any;
  if (!e || e.revoked_at)
    throw new Problem(409, "Execution environment is revoked or unavailable");
  return { ...h, ...e };
}
const clients = new Map<string, HapiClient>();
export function hub(e: any) {
  const url = process.env.LOOP_HAPI_URL,
    secret = process.env.LOOP_HAPI_TOKEN;
  if (!url || !secret)
    throw new Problem(503, "Private HAPI coordinator is not configured");
  const key = e.namespace;
  if (!clients.has(key))
    clients.set(key, new HapiClient(url, secret + ":" + e.namespace));
  return clients.get(key)!;
}
let dispatcher: Agent | undefined;
export async function workerRequest(
  e: any,
  path: string,
  body?: unknown,
): Promise<any> {
  if (!dispatcher) {
    const cert = process.env.LOOP_CONTROL_CERT,
      key = process.env.LOOP_CONTROL_KEY,
      ca = process.env.LOOP_CONTROL_CA;
    if (!cert || !key || !ca)
      throw new Problem(503, "Private worker mutual TLS is not configured");
    dispatcher = new Agent({
      connect: {
        cert: readFileSync(cert),
        key: readFileSync(key),
        ca: readFileSync(ca),
      },
    });
  }
  if (!e.url.startsWith("https://"))
    throw new Problem(503, "Worker control requires mutual TLS");
  const r = await secureFetch(e.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + unseal(e.secret, e.owner_id),
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    dispatcher,
    signal: AbortSignal.timeout(35000),
    redirect: "error",
  });
  const data: any = await r.json();
  if (!r.ok)
    throw new Problem(409, data.error || "Worker operation was not confirmed");
  return data;
}
export function provisionEnvironment(
  owner: string,
  input: {
    name: string;
    url: string;
    instanceId: string;
    namespace: string;
    credential: string;
    certificateFingerprint: string;
    capacity?: number;
  },
) {
  // Operator-only entry point. Never exposed as public self-asserted enrollment.
  const capacity = input.capacity ?? MAX_CONCURRENT_RUNS;
  if (
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > MAX_CONCURRENT_RUNS
  )
    throw new Error(
      `Environment capacity must be between 1 and ${MAX_CONCURRENT_RUNS}`,
    );
  if (
    !/^(?:i-[a-f0-9]{8,17}|local-[a-f0-9-]{36})$/.test(input.instanceId) ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(input.namespace) ||
    input.credential.length < 40 ||
    !/^[a-fA-F0-9:]{64,95}$/.test(input.certificateFingerprint)
  )
    throw new Error("Invalid provisioned environment identity");
  const prior = db
    .prepare("SELECT * FROM execution_environments WHERE namespace=?")
    .get(input.namespace) as any;
  if (prior) {
    if (
      prior.owner_id !== owner ||
      prior.instance_id !== input.instanceId ||
      prior.revoked_at ||
      prior.credential_hash !== digest(input.credential) ||
      prior.certificate_fingerprint !==
        input.certificateFingerprint.toUpperCase()
    )
      throw new Error(
        "Environment already exists with another identity; fence and explicitly recover it",
      );
    db.prepare(
      "UPDATE execution_environments SET capacity=? WHERE host_id=?",
    ).run(capacity, prior.host_id);
    return prior.host_id;
  }
  const hostId = id();
  db.transaction(() => {
    db.prepare(
      "INSERT INTO runtime_hosts(id,owner_id,name,url,secret,created_at,kind) VALUES(?,?,?,?,?,?,'native-host')",
    ).run(
      hostId,
      owner,
      input.name,
      input.url,
      seal(input.credential, owner),
      now(),
    );
    db.prepare(
      "INSERT INTO execution_environments(host_id,owner_id,instance_id,namespace,credential_hash,certificate_fingerprint,capacity) VALUES(?,?,?,?,?,?,?)",
    ).run(
      hostId,
      owner,
      input.instanceId,
      input.namespace,
      digest(input.credential),
      input.certificateFingerprint.toUpperCase(),
      capacity,
    );
  }).immediate();
  return hostId;
}
export async function refreshEnvironment(e: any) {
  try {
    const [machines, status] = await Promise.all([
      hub(e).request("/api/machines"),
      workerRequest(e, "/status"),
    ]);
    // A controller heartbeat alone never establishes Runner presence.
    const machine = machines.machines.find(
      (m: any) => m.id === status.machineId && m.active,
    );
    if (
      status.instanceId !== e.instance_id ||
      status.generation !== e.generation
    )
      throw new Error("Fenced identity");
    const state = machine ? "online" : "offline";
    db.prepare(
      "UPDATE execution_environments SET machine_id=?,state=?,health=?,last_seen=? WHERE host_id=? AND generation=? AND revoked_at IS NULL",
    ).run(
      status.machineId,
      state,
      JSON.stringify(status),
      now(),
      e.host_id,
      e.generation,
    );
    return { state, ...status };
  } catch {
    db.prepare(
      "UPDATE execution_environments SET state='offline' WHERE host_id=? AND revoked_at IS NULL",
    ).run(e.host_id);
    return { state: "offline" };
  }
}
