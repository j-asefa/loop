import { z } from "zod";
import type { RouteContract } from "./workspace-api.js";

export const TokenScope = z.enum(["read", "write", "approvals:decide"]);
export type TokenScope = z.infer<typeof TokenScope>;
export const TokenAdmission = z.enum([
  ...TokenScope.options,
  "results:read",
  "cards:read",
]);
export type TokenAdmission = z.infer<typeof TokenAdmission>;
export const TokenAdmissions = z.array(TokenAdmission).min(1).max(5);

export const SCOPE_CATALOG = {
  read: {
    label: "Read workspace",
    description:
      "Read agents, conversations, results, files and pending decisions across your projects.",
  },
  write: {
    label: "Send and control runs",
    description: "Send messages, reply and control admitted runs.",
  },
  "approvals:decide": {
    label: "Answer approvals",
    description:
      "Lets a script authorize tool calls and answer native decisions.",
  },
} as const satisfies Record<TokenScope, { label: string; description: string }>;

export function admitsToken(
  contract: RouteContract,
  admission: readonly TokenAdmission[],
) {
  return (
    contract.kind !== "transport" &&
    typeof contract.access === "object" &&
    contract.access.admits.some((scope) => admission.includes(scope))
  );
}

export function fullCardRead(admission: readonly TokenAdmission[]) {
  return admission.includes("read") || admission.includes("cards:read");
}
