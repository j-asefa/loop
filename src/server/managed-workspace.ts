import { db } from "./db.js";
import { Problem } from "./domain.js";
import { environment, workerRequest } from "./hapi/environments.js";
import { connectProvider } from "./hapi/routes.js";
import type { NativeSelection } from "./hapi/contracts.js";

// Set only by local provisioning; never infer a native host from its display name.
let binding: { owner: string; host: string } | undefined;
export function bindManagedWorkspace(owner: string, host: string) {
  const current = { owner, host };
  binding = current;
  return () => { if (binding === current) binding = undefined; };
}
export function managedWorkspace(owner: string) {
  if (!binding || binding.owner !== owner) return undefined;
  const e = environment(owner, binding.host);
  return e.state === "online" ? e : undefined;
}
export async function enableManagedWorkspace(
  owner: string,
  flavor: NativeSelection["flavor"],
  projectId: string,
  path: string,
  billing: "subscription" | "existing",
) {
  const e = managedWorkspace(owner);
  if (!e) return undefined;
  const inventory = await managedWorkspaceInventory(owner);
  if (!inventory)
    throw new Problem(409, "The execution environment changed. Refresh its runtime status.");
  // Only an explicitly unserved runtime may use its direct adapter. A failed
  // catalog request, billing check or managed enable never changes execution.
  if (!inventory.some((runtime) => runtime.name === flavor)) return undefined;
  const required = flavor === "pi" ? "existing" : "subscription";
  if (billing !== required)
    throw new Problem(422, `${flavor} on this managed runner requires ${required} billing. No billing fallback was attempted.`);
  const verified = await workerRequest(e, "/project/verify", {
    path, generation: e.generation,
  });
  // Do not register a connection after a runner was fenced during verification.
  const current = managedWorkspace(owner);
  if (!current || current.host_id !== e.host_id || current.generation !== e.generation)
    throw new Problem(409, "The execution environment changed. Retry after it is ready.");
  db.prepare(
    "INSERT INTO environment_projects VALUES(?,?,?,NULL) ON CONFLICT(environment_id,project_id) DO UPDATE SET canonical_path=excluded.canonical_path",
  ).run(e.host_id, projectId, verified.path);
  return { ...(await connectProvider(current, flavor)), backend: "hapi" };
}

export async function managedWorkspaceInventory(owner: string) {
  const e = managedWorkspace(owner);
  if (!e) return undefined;
  const result = await workerRequest(e, "/runtimes");
  const current = managedWorkspace(owner);
  if (!current || current.host_id !== e.host_id || current.generation !== e.generation)
    throw new Problem(409, "The execution environment changed. Refresh its runtime status.");
  if (!Array.isArray(result.runtimes))
    throw new Problem(502, "The managed runner returned an invalid runtime inventory.");
  return (["codex", "claude", "opencode", "pi"] as const)
    .filter((name) => result.runtimes.some((item: any) => item.flavor === name))
    .map((name) => {
    const runtime = result.runtimes?.find((item: any) => item.flavor === name);
    const enabled = db.prepare(
      "SELECT id FROM connections WHERE owner_id=? AND status='connected' AND json_extract(metadata,'$.backend')='hapi' AND json_extract(metadata,'$.environmentId')=? AND json_extract(metadata,'$.flavor')=?",
    ).get(owner, e.host_id, name);
    return {
      name, backend: "hapi" as const, environmentId: e.host_id, generation: e.generation,
      installed: runtime?.installed === true,
      available: runtime?.installed === true,
      enabled: !!enabled,
      authentication: runtime?.authentication === "signed_in" ? "signed_in"
        : runtime?.authentication === "signed_out" ? "signed_out" : "unknown",
      billing: name === "pi" ? "existing" : "subscription",
      help: "Enable and sign in on this computer’s managed runner.",
    };
  });
}
