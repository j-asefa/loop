// Read-only compatibility for archived HAPI records. No execution transport.
import { z } from "zod";

export const nativeSelection = z.object({
  backend: z.literal("hapi"),
  environmentId: z.string(),
  flavor: z.enum(["codex", "claude", "opencode", "pi"]),
  billing: z.object({
    mode: z.string(),
    requiredAuth: z.string(),
    allowApiFallback: z.literal(false),
  }),
});
export type NativeSelection = z.infer<typeof nativeSelection>;
export function isArchivedHapi(connection: { metadata: string }) {
  return JSON.parse(connection.metadata).backend === "hapi";
}
