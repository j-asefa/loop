import { Problem } from "./problem.js";
import type { RouteContract } from "./workspace-api.js";

/** Match only an existing named contract. URLs, query strings and recursively
 * routed source paths never create new forwarding capabilities. */
export function matchFleetRoute<C extends Record<string, RouteContract>>(
  routes: C,
  method: string,
  path: string,
) {
  if (path.length > 16_384 || /[?#]/.test(path))
    throw new Problem(400, "Choose a valid workspace operation path.");
  const parts = path.split("/");
  let selected:
    | {
        name: keyof C;
        contract: C[keyof C] & RouteContract;
        params: Record<string, string>;
      }
    | undefined;
  let parameterCount = Infinity;
  for (const [name, contract] of Object.entries(routes)) {
    if (contract.method !== method) continue;
    const pattern = contract.path.split("/");
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = Object.create(null);
    if (
      pattern.every((part, index) => {
        if (!part.startsWith(":")) return part === parts[index];
        if (!parts[index]) return false;
        try {
          params[part.slice(1)] = decodeURIComponent(parts[index]);
          return true;
        } catch {
          return false;
        }
      })
    ) {
      // Specific operations such as /runs/:id/move take precedence over
      // /runs/:id/:action regardless of the contract registry's order.
      const count = Object.keys(params).length;
      if (count >= parameterCount) continue;
      parameterCount = count;
      selected = {
        name: name as keyof C,
        contract: contract as C[keyof C] & RouteContract,
        params,
      };
    }
  }
  if (selected) return selected;
  throw new Problem(
    409,
    "This machine does not support this workspace operation. Update it or open its own workspace.",
  );
}
