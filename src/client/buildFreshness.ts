import type { DeploymentObservation } from "../shared/build";

// Receipt deadlines are local and monotonic. They survive view-cache reuse,
// but deserialized snapshots have no receipt and cannot become live on mount.
const deadlines = new WeakMap<object, number>();

/** Called only for successful API responses, never when reading cached views. */
export function receiveBuildObservations(
  data: unknown,
  requestStarted: number,
) {
  if (!data || typeof data !== "object") return;
  const page = data as { deployments?: unknown; items?: unknown };
  if (Array.isArray(page.deployments))
    for (const observation of page.deployments) {
      if (!observation || typeof observation !== "object") continue;
      const { checkedAt, validUntil } = observation;
      if (!Number.isFinite(checkedAt) || !Number.isFinite(validUntil)) continue;
      // Deduct the whole request duration conservatively. Network delay cannot
      // extend the lifetime granted by the server's heartbeat observations.
      deadlines.set(
        observation,
        requestStarted + Math.max(0, Math.min(20_000, validUntil - checkedAt)),
      );
    }
  if (Array.isArray(page.items))
    for (const item of page.items)
      receiveBuildObservations(item, requestStarted);
}

export function buildObservationCurrent(observation: DeploymentObservation) {
  return (
    observation.current && (deadlines.get(observation) ?? 0) > performance.now()
  );
}
