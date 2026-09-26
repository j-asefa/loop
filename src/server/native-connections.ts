import type { Connection } from "../shared/types.js";

// Match the SQL predicate, including metadata that has a non-null marker.
export const isNativeConnection = (connection: Pick<Connection, "metadata">) =>
  JSON.parse(connection.metadata).loopHarness != null;

// Callers qualify metadata through the connections alias c.
export const NATIVE_CONNECTION_SQL =
  "json_extract(c.metadata,'$.loopHarness') IS NOT NULL";
