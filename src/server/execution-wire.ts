import { Problem } from "../shared/problem.js";

/** Round-trip even the in-process path: no live object crosses the boundary. */
export function boundedExecutionJson(value: unknown, limit: number): unknown {
  let wire: string | undefined;
  try {
    wire = JSON.stringify(value);
  } catch {
    throw new Problem(400, "Execution message must be JSON.");
  }
  if (!wire || Buffer.byteLength(wire) > limit)
    throw new Problem(413, "Execution message exceeds its size limit.");
  return JSON.parse(wire);
}
