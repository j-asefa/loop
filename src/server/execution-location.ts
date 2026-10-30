import "../../deployment/environment.mjs";
import { computerName } from "../computer-name.js";

// Where an execution environment runs, recorded on connections so the client
// never has to infer it from a display name. Loop55's own process counts as
// Docker inside the companion container, since its harnesses run there too.
export type ExecutionLocation = "laptop" | "docker";
// Legacy provisioner names classify existing environments, not display labels.
export const LOCAL_ENVIRONMENT_NAMES = {
  native: "This laptop",
  docker: "Docker",
} as const;

export function hostLocation(): ExecutionLocation {
  return process.env.LOOP55_COMPANION_CONTAINER === "1" ? "docker" : "laptop";
}

export function hostEnvironmentName(): string {
  if (hostLocation() !== "docker") return computerName();
  const name = process.env.LOOP55_ENVIRONMENT_NAME?.trim() || computerName();
  return name === "This computer" ? "Docker" : `Docker · ${name}`;
}

// Only environments provisioned by this process's local runtime (instance
// ids `local-…`) have a known location; their names are assigned by Loop55.
export function environmentLocation(e: {
  instance_id?: string | null;
  name?: string | null;
}): ExecutionLocation | undefined {
  if (!e.instance_id?.startsWith("local-")) return undefined;
  return e.name === LOCAL_ENVIRONMENT_NAMES.docker ? "docker" : hostLocation();
}
