import { computerName } from "../computer-name.js";

// Where an execution environment runs, recorded on connections so the client
// never has to infer it from a display name. Loop's own process counts as
// Docker inside the companion container, since its harnesses run there too.
export type ExecutionLocation = "laptop" | "docker";
export function hostLocation(): ExecutionLocation {
  return process.env.LOOP_COMPANION_CONTAINER === "1" ? "docker" : "laptop";
}

export function hostEnvironmentName(): string {
  if (hostLocation() !== "docker") return computerName();
  const name = process.env.LOOP_ENVIRONMENT_NAME?.trim() || computerName();
  return name === "This computer" ? "Docker" : `Docker · ${name}`;
}
