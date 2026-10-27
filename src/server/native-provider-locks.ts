import { ExecutionRefused } from "./execution-refusal.js";

const changes = new Set<string>();
export const providerChangeInProgress = (name: string) => changes.has(name);
export function reserveProviderChange(name: string) {
  if (changes.has(name))
    throw new ExecutionRefused(
      409,
      "A provider change is already in progress. Check its status before trying again.",
    );
  changes.add(name);
  return () => {
    changes.delete(name);
  };
}
