// Authentication evidence belongs to one backend and runner generation.
export function runtimeAuthScope(runtime: {
  name: string;
  backend?: "hapi" | "direct";
  environmentId?: string;
  generation?: number;
}): string {
  return JSON.stringify([
    runtime.name,
    runtime.backend || "direct",
    runtime.environmentId || "",
    runtime.generation ?? null,
  ]);
}
