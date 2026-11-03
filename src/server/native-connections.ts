import { type Connection } from "./row-schemas.js";

// Match the SQL predicate, including metadata that has a non-null marker.
export const isNativeConnection = (connection: Pick<Connection, "metadata">) =>
  connection.metadata.loopHarness != null;

// Only these harness adapters take input mid-turn; API and subscription
// runtimes do too. Replies to other harnesses queue for the next turn.
import { LIVE_INPUT_HARNESSES } from "./sql/connections.js";

export const acceptsLiveInput = (connection: Pick<Connection, "metadata">) => {
  const harness = connection.metadata.loopHarness;
  return harness == null || LIVE_INPUT_HARNESSES.has(harness);
};
// The same rule for a run, from the connection it was started with (its
// payload snapshot), not the agent's or conversation's current one: an
// agent can switch connections while a run is active. A run whose
// connection is gone takes no live input.
export { RUN_LIVE_INPUT_SQL } from "./sql/runs.js";
export { NATIVE_CONNECTION_SQL } from "./sql/connections.js";
