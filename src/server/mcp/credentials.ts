import { safeUrl } from "./network.js";
import type { AuthSecret } from "./client.js";

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
