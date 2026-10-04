import type { Connection } from "../shared/types.js";

// Match the SQL predicate, including metadata that has a non-null marker.
export const isNativeConnection = (connection: Pick<Connection, "metadata">) =>
  JSON.parse(connection.metadata).loopHarness != null;

// Only these harness adapters take input mid-turn; API and subscription
// runtimes do too. Replies to other harnesses queue for the next turn.
const LIVE_INPUT_HARNESSES = new Set(["codex", "claude", "pi"]);
export const acceptsLiveInput = (connection: Pick<Connection, "metadata">) => {
  const harness = JSON.parse(connection.metadata).loopHarness;
  return harness == null || LIVE_INPUT_HARNESSES.has(harness);
};
// The same rule for a run, from the connection it was started with (its
// payload snapshot), not the agent's or conversation's current one: an
// agent can switch connections while a run is active. A HAPI run or a run
// whose connection is gone takes no live input.
export const RUN_LIVE_INPUT_SQL = (r: string) =>
  `(json_extract(${r}.payload,'$.execution.backend') IS NOT 'hapi' AND EXISTS(SELECT 1 FROM connections lc WHERE lc.id=json_extract(${r}.payload,'$.connectionId') AND lc.owner_id=${r}.owner_id AND COALESCE(json_extract(lc.metadata,'$.loopHarness'),'') IN ('',${[...LIVE_INPUT_HARNESSES].map((h) => `'${h}'`).join(",")})))`;

// Callers qualify metadata through the connections alias c.
export const NATIVE_CONNECTION_SQL =
  "json_extract(c.metadata,'$.loopHarness') IS NOT NULL";

// Queue policy only: HAPI has independent sessions without being a direct harness.
// Match existing HAPI metadata too, so no connection migration is required.
export const PER_CONVERSATION_CONNECTION_SQL =
  `(${NATIVE_CONNECTION_SQL} OR json_extract(c.metadata,'$.backend')='hapi')`;
