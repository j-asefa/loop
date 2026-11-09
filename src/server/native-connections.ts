import { type Connection } from "./row-schemas.js";

// Match the SQL predicate, including metadata that has a non-null marker.
export const isNativeConnection = (connection: Pick<Connection, "metadata">) =>
  connection.metadata.loopHarness != null;
