import { z } from "zod";
import { Problem } from "./problem.js";
import type { RouteContract, RouteInput } from "./workspace-api.js";

type ParameterPath<P extends string> = P extends `${infer Head}:${string}/${infer Tail}`
  ? `${Head}${string}/${ParameterPath<Tail>}` : P extends `${infer Head}:${string}` ? `${Head}${string}` : P;
export type RoutePath<P extends string> = ParameterPath<P> | `${ParameterPath<P>}?${string}`;

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
export function routePath<C extends RouteContract>(contract: C, input: RouteInput<C>): RoutePath<C["path"]> {
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
  return (path + (serialized ? "?" + serialized : "")) as RoutePath<C["path"]>;
}
