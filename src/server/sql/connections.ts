export const LIVE_INPUT_HARNESSES = new Set(["codex", "claude", "pi", "muse"]);

// Callers qualify metadata through the connections alias c.
export const NATIVE_CONNECTION_SQL =
  "json_extract(c.metadata,'$.loop55Harness') IS NOT NULL";
