import type { Connection } from "../shared/types.js";

// Match the SQL predicate, including metadata that has a non-null marker.
export const isNativeConnection = (connection: Pick<Connection, "metadata">) =>
  JSON.parse(connection.metadata).loopHarness != null;

// Callers qualify metadata through the connections alias c.
export const NATIVE_CONNECTION_SQL =
  "json_extract(c.metadata,'$.loopHarness') IS NOT NULL";

// Queue policy only: HAPI has independent sessions without being a direct harness.
// Match existing HAPI metadata too, so no connection migration is required.
export const PER_CONVERSATION_CONNECTION_SQL =
  `(${NATIVE_CONNECTION_SQL} OR json_extract(c.metadata,'$.backend')='hapi')`;
