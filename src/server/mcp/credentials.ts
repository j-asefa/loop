import * as mcpConnectionsQueries from "../sql/mcp-connections.js";
import { db } from "../db.js";
import { seal, unseal } from "../secrets.js";
import { safeUrl } from "./network.js";
import type { AuthSecret, MCPConnection } from "./client.js";

// Treat all query values as credentials: publishers choose their own key names.
// This also supports combined header/query auth and repeated query parameters.
export function privateMcpUrl(value: string, auth: AuthSecret) {
  const url = safeUrl(value);
  const query = Object.fromEntries(
    [...new Set(url.searchParams.keys())].map((key) => {
      const values = url.searchParams.getAll(key);
      return [key, values.length === 1 ? values[0] : values];
    }),
  );
  url.search = "";
  return {
    url: url.toString(),
    auth: Object.keys(query).length
      ? {
          ...auth,
          type: auth.type === "none" ? ("query" as const) : auth.type,
          query: { ...query, ...auth.query },
        }
      : auth,
  };
}

// Earlier JSON/manual installs stored the full URL. Repair them before either
// the API or worker starts, preserving their owner, credentials and identity.
export function migrateMcpUrlCredentials() {
  db.transaction(() => {
    const rows = mcpConnectionsQueries.credentialUrls(db) as MCPConnection[];
    for (const row of rows) {
      const auth: AuthSecret = row.secret
        ? JSON.parse(unseal(row.secret, row.owner_id))
        : { type: "none" };
      const clean = privateMcpUrl(row.url, auth);
      mcpConnectionsQueries.setPrivateUrl(
        db,
        clean.url,
        seal(
          JSON.stringify(row.status === "disconnected" ? auth : clean.auth),
          row.owner_id,
        ),
        row.id,
      );
    }
  }).immediate();
}
