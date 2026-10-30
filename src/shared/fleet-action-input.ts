import { z } from "zod";
import { Problem } from "./problem.js";
import {
  FleetActionInput,
  fleetActionRoutes,
} from "./fleet-workspace-action-api.js";

/** The identity positions are shared by browser receipts and destination
 * normalization. They are never inferred from arbitrary nested JSON keys. */
export function fleetActionCommandPaths(input: FleetActionInput): string[][] {
  if (
    ["agentCreate", "submit", "scheduledSendCreate", "runMove"].includes(
      input.route,
    ) ||
    (input.route === "runAction" && input.params.action === "retry")
  )
    return [["idempotencyKey"]];
  if (["nativeAnswer", "setting"].includes(input.route)) return [["commandId"]];
  if (
    ["conversationContinue", "conversationContinueStart"].includes(
      input.route,
    ) &&
    input.body &&
    typeof input.body === "object" &&
    !Array.isArray(input.body) &&
    "start" in input.body
  )
    return [["start", "idempotencyKey"]];
  return [];
}

/** The outer durable identity also owns any existing inner receipt key. */
export function fleetActionInput(
  input: FleetActionInput,
  commandId: string,
): FleetActionInput {
  z.string().uuid().parse(commandId);
  const value = FleetActionInput.parse(input);
  const body = structuredClone(value.body ?? {});
  const bind = (key: string, target: unknown = body) => {
    if (target === null || typeof target !== "object" || Array.isArray(target))
      throw new Problem(400, "Choose a valid workspace action body.");
    const record = target as Record<string, unknown>;
    if (record[key] !== undefined && record[key] !== commandId)
      throw new Problem(
        409,
        "The workspace action has a different command identity.",
      );
    record[key] = commandId;
  };
  if (value.route === "runAction") {
    if (
      !["dismiss", "cancel", "pause", "resume", "retry"].includes(
        value.params.action,
      )
    )
      throw new Problem(400, "Choose a supported run action.");
  }
  for (const path of fleetActionCommandPaths(value)) {
    const [key, nested] = path;
    bind(
      nested ?? key,
      nested && body && typeof body === "object" && !Array.isArray(body)
        ? body[key]
        : body,
    );
  }
  const contract = fleetActionRoutes[value.route];
  const params = contract.params.parse(value.params) as Record<string, string>;
  const parsedBody = contract.body.parse(body);
  return FleetActionInput.parse({
    route: value.route,
    params,
    body: parsedBody ?? {},
  });
}
