import { type Connection } from "./row-schemas.js";

// Match the SQL predicate, including metadata that has a non-null marker.
export const isNativeConnection = (connection: Pick<Connection, "metadata">) =>
  connection.metadata.loop55Harness != null;

// Only these harness adapters take input mid-turn; API and subscription
// runtimes do too. Replies to other harnesses queue for the next turn.
const LIVE_INPUT_HARNESSES = new Set(["codex", "claude", "pi", "muse"]);
export const acceptsLiveInput = (connection: Pick<Connection, "metadata">) => {
  const harness = connection.metadata.loop55Harness;
  return harness == null || LIVE_INPUT_HARNESSES.has(harness);
};
// The same rule for a run, from the connection it was started with (its
// payload snapshot), not the agent's or conversation's current one: an
// agent can switch connections while a run is active. A run whose
// connection is gone takes no live input.
export const RUN_LIVE_INPUT_SQL = (r: string) =>
  `(EXISTS(SELECT 1 FROM connections lc WHERE lc.id=json_extract(${r}.payload,'$.connectionId') AND lc.owner_id=${r}.owner_id AND COALESCE(json_extract(lc.metadata,'$.loop55Harness'),'') IN ('',${[...LIVE_INPUT_HARNESSES].map((h) => `'${h}'`).join(",")})))`;

// Callers qualify metadata through the connections alias c.
export const NATIVE_CONNECTION_SQL =
  "json_extract(c.metadata,'$.loop55Harness') IS NOT NULL";
