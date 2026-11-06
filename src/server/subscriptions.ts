import * as connectionsQueries from "./sql/connections.js";
import { SubscriptionCodeInput } from "../shared/companion-contract-schemas.js";
import { workspaceApi } from "../shared/workspace-api.js";
import { projectResponse, registrar } from "./registrar.js";
import {
  ConnectionMetadata,
  ConnectionModels,
  requireSealedSecret,
  type Connection,
  type ConnectionControl,
} from "./row-schemas.js";

import { writeConnectionStatus } from "./connection-status.js";
import { errorSummary, errorFacts } from "../../runtime/diagnostics.ts";
import { isNativeConnection } from "./native-connections.js";
import { inlineAttachments } from "./uploads.js";
import { executionRequest } from "./execution-client.js";

import { z } from "zod";
import { db, now } from "./db.js";
import { ownedConnection, Problem } from "./domain.js";
import { adapter, type ChatInput } from "./providers.js";
import { unseal } from "./secrets.js";

export const isSubscription = (c: Pick<Connection, "metadata">) =>
  c.metadata.authMode === "subscription" || isNativeConnection(c);
// Native results differ by action; callers project them to their route's shape.
export async function runtimeAction(
  c: ConnectionControl,
  action: string,
): Promise<any> {
  const harness = c.metadata.loopHarness;
  if (!harness)
    throw new Problem(409, "This connection has no runtime on this computer.");
  if (action === "logout" || action === "cancel") return { ok: true };
  if (action === "status")
    return executionRequest(
      "runtime.refresh",
      { connectionId: c.id },
      { owner: c.owner_id },
    );
  throw new Problem(
    409,
    "Sign in with the native harness on this computer, then run loop " +
      harness,
  );
}
export async function* streamConnection(c: Connection, input: ChatInput) {
  if (isSubscription(c))
    throw new Problem(
      409,
      "Native conversations execute through their durable session.",
    );
  // Resolve attachment bytes only at the provider boundary. Checkpoints store
  // references, so large documents are not copied into every history snapshot.
  input = {
    ...input,
    messages: inlineAttachments(c.owner_id, input.messages),
  };
  try {
    yield* adapter(c.provider).stream(
      unseal(requireSealedSecret(c), c.owner_id),
      input,
    );
  } catch (error) {
    // Only failures from the provider stream can invalidate its credentials.
    // MCP ownership and approvals are checked outside this boundary.
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      (error.status === 401 || error.status === 403)
    )
      writeConnectionStatus(c.id, () =>
        connectionsQueries.subscriptionNeedsReconnect(db, c.id, c.owner_id),
      );
    if (error instanceof Problem || input.signal.aborted) throw error;
    throw new Problem(
      502,
      `${c.provider === "anthropic" ? "Claude" : "OpenAI"} provider: ${errorSummary(error, [unseal(requireSealedSecret(c), c.owner_id)])}`,
      errorFacts(error),
    );
  }
}
const routes = registrar("subscriptions");
export const subscriptions = routes.mount;
routes.on(workspaceApi.subscriptionAction, async (req, res) => {
  const c = ownedConnection(String(req.params.id), res.locals.owner);
  if (!isSubscription(c))
    throw new Problem(400, "This connection uses an API key");
  const action = req.params.action;
  if (action === "status" && c.status === "disconnected") {
    res.json({ authenticated: false });
    return;
  }
  if (action === "code") {
    SubscriptionCodeInput.parse(req.body);
    res.json(await runtimeAction(c, action));
    return;
  }
  if (action === "login")
    writeConnectionStatus(c.id, () => connectionsQueries.signingIn(db, c.id));
  let result;
  try {
    result = projectResponse(
      workspaceApi.subscriptionAction,
      await runtimeAction(c, action),
    );
  } catch (error) {
    if (action === "login")
      writeConnectionStatus(c.id, () =>
        connectionsQueries.resetSigningIn(db, c.id),
      );
    throw error;
  }
  if (ownedConnection(c.id, c.owner_id).status === "disconnected") {
    res.json({ authenticated: false });
    return;
  }
  // Only expose the native runtime's auth result. A login URL is never proof of connection.
  if (
    "authenticated" in result &&
    result.authenticated === true &&
    result.authMode === "subscription"
  ) {
    const models = z
      .array(
        z.object({
          id: z.string().max(200),
          name: z.string().max(200),
          resolvedModel: z.string().min(1).max(200).optional(),
          capabilities: z.string().max(500),
          effortLevels: z
            .array(
              z.object({
                value: z.string().max(32),
                description: z.string().max(1000).optional(),
              }),
            )
            .max(20)
            .optional(),
          defaultEffort: z.string().max(32).optional(),
        }),
      )
      .max(300)
      .parse(result.models);
    writeConnectionStatus(c.id, () =>
      connectionsQueries.subscriptionConnected(
        db,
        JSON.stringify(ConnectionModels.parse(models)),
        JSON.stringify({
          ...c.metadata,
          // Preserve validated historical fields in place; only this status
          // patch is new data and must pass the strict write schema.
          ...ConnectionMetadata.parse({
            plan: result.plan,
            limits: result.limits,
            checkedAt: now(),
          }),
        }),
        c.id,
      ),
    );
  } else if (
    ("authenticated" in result && result.authenticated === false) ||
    ("state" in result &&
      result.state &&
      ["failed", "cancelled"].includes(result.state)) ||
    action === "cancel"
  ) {
    writeConnectionStatus(c.id, () =>
      connectionsQueries.subscriptionNeedsSignIn(db, c.id),
    );
  }
  res.json(result);
});
