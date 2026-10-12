import { computerName } from "../computer-name.js";

// Where an execution environment runs, recorded on connections so the client
// never has to infer it from a display name. Loop's own process counts as
// Docker inside the companion container, since its harnesses run there too.
export type ExecutionLocation = "laptop" | "docker";
// Legacy provisioner names classify existing environments, not display labels.
export const LOCAL_ENVIRONMENT_NAMES = {
  native: "This laptop",
  docker: "Docker",
} as const;

export function hostLocation(): ExecutionLocation {
  return process.env.LOOP_COMPANION_CONTAINER === "1" ? "docker" : "laptop";
}

export function hostEnvironmentName(): string {
  return hostLocation() === "docker"
    ? LOCAL_ENVIRONMENT_NAMES.docker
    : computerName();
}

// Only environments provisioned by this process's local runtime (instance
// ids `local-…`) have a known location; their names are assigned by Loop.
export function environmentLocation(e: {
  instance_id?: string | null;
  name?: string | null;
}): ExecutionLocation | undefined {
  if (!e.instance_id?.startsWith("local-")) return undefined;
  return e.name === LOCAL_ENVIRONMENT_NAMES.docker ? "docker" : hostLocation();
}
