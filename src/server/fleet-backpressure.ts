import { Problem } from "../shared/problem.js";

/** Advisory transport delay only. It says nothing about whether an external
 * command was accepted; that decision still requires its durable receipt. */
export function fleetRetryDelay(
  value: string | null | undefined,
  now = Date.now(),
) {
  const text = value?.trim() ?? "";
  const milliseconds = /^\d+(\.\d+)?$/.test(text)
    ? Number(text) * 1000
    : Date.parse(text) - now;
  return Number.isFinite(milliseconds)
    ? Math.max(1000, Math.min(milliseconds, 300_000))
    : 1000;
}
export function fleetBackpressure(milliseconds = 1000) {
  return new Problem(
    503,
    "Fleet connections are busy. Retry after capacity is available.",
    { retryAfterMs: Math.ceil(Math.max(1000, milliseconds)) },
  );
}
