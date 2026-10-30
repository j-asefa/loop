import { Problem } from "./problem.js";

/** Signing sorts object keys, never arrays. Callers supply parsed JSON. */
export function canonicalFleetJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalFleetJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${canonicalFleetJson(item)}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Browser receipts and destination acceptance hash exactly these bytes. */
export function fleetOperationBytes(input: unknown, maxBytes = 1024 * 1024) {
  const json = JSON.stringify(input);
  const encoder = new TextEncoder();
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > 4 * 1024 * 1024 ||
    json === undefined ||
    encoder.encode(json).length > maxBytes
  )
    throw new Problem(413, "Fleet operation input is too large.");
  return encoder.encode(
    `loop:fleet:operation:v1\n${canonicalFleetJson(JSON.parse(json))}`,
  );
}
