import { type Connection } from "./row-schemas.js";

// Match the SQL predicate, including metadata that has a non-null marker.
export const isNativeConnection = (connection: Pick<Connection, "metadata">) =>
  connection.metadata.loopHarness != null;

// The same rule for a run, from the connection it was started with (its
// payload snapshot), not the agent's or conversation's current one: an
// agent can switch connections while a run is active. A run whose
// connection is gone takes no live input.
export { RUN_LIVE_INPUT_SQL } from "./sql/runs.js";
export { NATIVE_CONNECTION_SQL } from "./sql/connections.js";
