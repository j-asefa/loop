// Bundled and loaded only by the managed Pi launcher. Descriptor 3 is private
// launcher IPC, never native chat output or the browser-visible activity stream.
import { readFileSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { registerManagedPiMcp } from "./pi-mcp";

export function piManagedBinding(env: NodeJS.ProcessEnv = process.env) {
  const path = env.LOOP_LAUNCH_FILE;
  if (!path || !isAbsolute(path) || !env.LOOP_LAUNCH_ID ||
      !/^[0-9a-f-]{36}$/.test(env.LOOP_LAUNCH_ID))
    throw new Error("Invalid managed Pi launch binding");
  const binding = JSON.parse(readFileSync(path, "utf8"));
  const generation = Number(env.LOOP_ENVIRONMENT_GENERATION);
  if (!Number.isSafeInteger(generation) || generation < 1 ||
      binding.generation !== generation || binding.launchId !== env.LOOP_LAUNCH_ID ||
      binding.flavor !== "pi" || binding.billing?.mode !== "existing" ||
      binding.billing?.requiredAuth !== "pi" || binding.billing?.allowApiFallback !== false)
    throw new Error("Fenced managed Pi launch binding");
  const url = new URL(binding.gatewayUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash ||
      typeof binding.gatewayToken !== "string" || !binding.gatewayToken || /[\r\n]/.test(binding.gatewayToken))
    throw new Error("Invalid managed Pi tool binding");
  return { gatewayUrl: url.href, gatewayToken: binding.gatewayToken, generation };
}

export default function managedPiExtension(pi: Parameters<typeof registerManagedPiMcp>[0]) {
  registerManagedPiMcp(pi, () => piManagedBinding(), undefined, (ready) => {
    writeSync(3, JSON.stringify({ type: "loop-mcp-ready", ready }) + "\n");
  });
}
