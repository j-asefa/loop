import { z } from "zod";
import { Problem } from "../shared/problem";
import { apiInWorkspace, readInWorkspace } from "./api";
import type { RouteContract, RouteInput, RouteResponse } from "../shared/workspace-api";

// Callers can keep their existing invalid-snapshot recovery policy without
// exposing validation details or treating malformed output as a transient GET.
export class UnavailableResponse extends Error {
  constructor() {
    super("The workspace returned an unavailable response. Refresh before trying again.");
    this.name = "UnavailableResponse";
  }
}

/** Validate before sending, but serialize the input: server defaults and query
 * coercions must run once on the receiving side, not become new wire values. */
function validateInput<C extends RouteContract>(contract: C, input: RouteInput<C>) {
  try {
    const params = z.record(z.string(), z.string()).parse(contract.params.parse(input.params ?? {}));
    contract.query.parse(input.query ?? {});
    contract.body.parse(input.body);
    return params;
  } catch (error) {
    // Nothing reached transport. Match the server's validation refusal so send
    // receipts can change intent, without classifying response failures as safe.
    if (error instanceof z.ZodError)
      throw new Problem(400, error.issues.map(issue => issue.message).join("; "));
    throw error;
  }
}
export function routePath<C extends RouteContract>(contract: C, input: RouteInput<C>) {
  const params = validateInput(contract, input);
  const path = contract.path.replace(/:([^/]+)/g, (_, key: string) => {
    if (params[key] === undefined) throw new Error("Missing route parameter: " + key);
    return encodeURIComponent(params[key]);
  });
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) query.set(key, String(value));
  }
  const serialized = query.toString();
  return path + (serialized ? "?" + serialized : "");
}
function response<C extends RouteContract>(contract: C, value: unknown): RouteResponse<C> {
  const parsed = contract.response.safeParse(value);
  if (!parsed.success) throw new UnavailableResponse();
  return parsed.data as RouteResponse<C>;
}
export async function callRoute<C extends RouteContract>(contract: C, input: RouteInput<C>, sourceId: string, signal?: AbortSignal): Promise<RouteResponse<C>> {
  return response(contract, await apiInWorkspace<unknown>(routePath(contract, input), sourceId, input.body, contract.method, signal));
}
export async function readRoute<C extends RouteContract & { method: "GET" }>(contract: C, input: RouteInput<C>, sourceId: string, signal: AbortSignal, onRetry?: (error: unknown) => void): Promise<RouteResponse<C>> {
  return response(contract, await readInWorkspace<unknown>(routePath(contract, input), sourceId, signal, onRetry));
}
