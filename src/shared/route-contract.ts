import type { TokenAdmission } from "./token-scopes.js";
import { z } from "zod";

export const Text = z.string();
export const MaybeText = Text.nullable();
export const Time = z.number();
export const Empty = z.object({});
export const NoBody = z.undefined();
export const Ok = z.object({ ok: z.boolean() });
export const NumberCursor = z.coerce
  .number<string>()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
type PeerAccess =
  | "peer:enrollment"
  | "peer:handoff"
  | "peer:directory"
  | "peer:credentials"
  | "peer:workspace";
type SessionAccess = "session" | PeerAccess | "device:fleet";
export type RouteContract = {
  // Workspace endpoints require a stable operation; peer contracts do not use token receipts.
  operation?: string;
  path: string;
  params: z.ZodType;
  query: z.ZodType;
  body: z.ZodType;
  response: z.ZodType;
  status?: number;
  // Body field required for a bearer mutation; owner-session writes keep their own authentication.
  identity?: string;
  // Other statuses using this response shape (accepted replay or health failure).
  additionalStatuses?: readonly number[];
  // One file part named "file", plus the ordinary body schema's text fields.
  multipart?: true;
  contentType?: string;
  // Documentation of existing middleware; never an authorization bypass.
  security?:
    "public" | "optional-session" | "paired-device" | "integration-token";
} & { kind?: "stream" } & (
    | {
        method: "GET";
        access: SessionAccess | { admits: readonly TokenAdmission[] };
      }
    | {
        method: "POST" | "PUT" | "PATCH" | "DELETE";
        access:
          | SessionAccess
          | {
              admits: readonly Exclude<
                TokenAdmission,
                "write" | "approvals:decide"
              >[];
            };
      }
    | {
        method: "POST" | "PUT" | "PATCH" | "DELETE";
        access: { admits: readonly TokenAdmission[] };
        identity: string;
      }
  );
export type FleetRouteContract = RouteContract & {
  access: PeerAccess | "device:fleet";
};
export type ClientRouteContract = RouteContract;

export const endpoint = <const C extends RouteContract & { operation: string }>(
  contract: C,
) => contract;
export const base = {
  params: Empty,
  query: Empty,
  body: NoBody,
  access: "session" as const,
};
type Field<K extends string, S extends z.ZodType> =
  undefined extends z.input<S>
    ? { [P in K]?: z.input<S> }
    : {} extends z.input<S>
      ? { [P in K]?: z.input<S> }
      : { [P in K]: z.input<S> };
export type RouteInput<C extends RouteContract> = Field<"params", C["params"]> &
  Field<"query", C["query"]> &
  Field<"body", C["body"]> &
  (C extends { multipart: true } ? { file: Blob; filename?: string } : {});
export type RouteResponse<C extends RouteContract> = z.output<C["response"]>;
