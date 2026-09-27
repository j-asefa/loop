import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Problem } from "../domain.js";

export const billingPolicy = Object.freeze({
  mode: "subscription",
  requiredAuth: "chatgpt",
  allowApiFallback: false,
});
export const claudePolicy = Object.freeze({
  mode: "native",
  requiredAuth: "claude",
  allowApiFallback: false,
});
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export function matchesSecret(secret: string, hash: string) {
  return (
    /^[a-f0-9]{64}$/.test(hash) &&
    timingSafeEqual(Buffer.from(digest(secret)), Buffer.from(hash))
  );
}
export function verifyAuth(flavor: string, evidence: any) {
  if (
    !evidence ||
    evidence.authenticated !== true ||
    evidence.managed !== true ||
    !Number.isFinite(evidence.checkedAt) ||
    Date.now() - evidence.checkedAt > 30000 ||
    evidence.checkedAt > Date.now() + 5000 ||
    (flavor === "codex" && evidence.authMethod !== "chatgpt") ||
    (flavor === "claude" && evidence.authMethod !== "claude")
  )
    throw new Problem(
      409,
      "Native sign-in must be verified on this environment. API fallback is disabled.",
    );
}
export const nativeSelection = z.object({
  backend: z.literal("hapi"),
  environmentId: z.string(),
  flavor: z.enum(["codex", "claude"]),
  billing: z.object({
    mode: z.string(),
    requiredAuth: z.string(),
    allowApiFallback: z.literal(false),
  }),
});
export type NativeSelection = z.infer<typeof nativeSelection>;
export function connectionSelection(connection: {
  metadata: string;
}): NativeSelection | undefined {
  const m = JSON.parse(connection.metadata);
  if (m.backend !== "hapi") return;
  const s = nativeSelection.parse(m);
  const required = s.flavor === "codex" ? billingPolicy : claudePolicy;
  if (JSON.stringify(s.billing) !== JSON.stringify(required))
    throw new Problem(409, "Native billing policy is invalid");
  return s;
}
export type NativeSession = {
  conversation_id: string;
  owner_id: string;
  environment_id: string;
  generation: number;
  flavor: "codex" | "claude";
  billing: string;
  launch_id: string;
  hub_session_id: string | null;
  native_thread_id: string | null;
  state: string;
  lineage: string;
  coherent: number;
  history_epoch: number | null;
  cursor_seq: number | null;
  cursor_at: number | null;
  sse_cursor: string | null;
  gateway_secret: string;
  gateway_hash: string;
};
export type NativeDispatch = {
  run_id: string;
  conversation_id: string;
  local_id: string;
  state: string;
  envelope: string;
  native_turn_id: string | null;
  send_started_at: number | null;
  cancel_requested: number;
  billing: string;
};
