import * as connectionsQueries from "./sql/connections.js";
import { requireSealedSecret, type Connection } from "./row-schemas.js";

import { writeConnectionStatus } from "./connection-status.js";
import { errorSummary, errorFacts } from "../../runtime/diagnostics.ts";
import { isNativeConnection } from "./native-connections.js";
import { inlineAttachments } from "./uploads.js";

import { db } from "./db.js";
import { Problem } from "./domain.js";
import { adapter, type ChatInput } from "./providers.js";
import { unseal } from "./secrets.js";

export const isSubscription = (c: Pick<Connection, "metadata">) =>
  c.metadata.authMode === "subscription" || isNativeConnection(c);
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
