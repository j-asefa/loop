import { z } from "zod";
import { AgentSnapshot } from "./agent-snapshot.js";
const Id = z.string().min(1);
// Agent previews and complete execution snapshots share kind=agent. Keep one
// payload schema; each executor validates its complete inputs before effects.
export const RunPayload = AgentSnapshot.partial().extend({
  importId: Id.optional(),
  tool: Id.optional(),
  arguments: z.record(z.string(), z.json()).optional(),
  idempotencyKey: Id.optional(),
});
export type RunPayload = z.infer<typeof RunPayload>;
// Recovery reads only the field it carries into a fresh turn. Unrelated corrupt
// execution fields must not prevent recovery or become execution defaults.
const recoveryFields = {
  folderId: RunPayload.pick({ folderId: true }).strip(),
  reviewId: RunPayload.pick({ reviewId: true }).strip(),
  connectionId: RunPayload.pick({ connectionId: true }).strip(),
};
export type RunPayloadField = keyof typeof recoveryFields;
export function readRunPayload(
  value: unknown,
  failure: "throw" | "fallback" = "throw",
  field?: RunPayloadField,
): RunPayload {
  try {
    const schema = field ? recoveryFields[field] : RunPayload;
    return schema.parse(typeof value === "string" ? JSON.parse(value) : value);
  } catch (error) {
    if (failure === "throw") throw error;
    return {};
  }
}
export function writeRunPayload(value: RunPayload): string {
  return JSON.stringify(RunPayload.parse(value));
}
