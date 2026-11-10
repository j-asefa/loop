import type { AuthSecret } from "./client.js";
import { redactValues } from "../../shared/redaction.js";

export function redactCredentials(value: unknown, secrets: AuthSecret[]): any {
  const values = secrets
    .flatMap((secret) => [
      secret.token,
      secret.tokens?.access_token,
      secret.tokens?.refresh_token,
      secret.client?.client_secret,
      ...Object.values(secret.headers || {}),
      ...Object.values(secret.query || {}).flat(),
      ...Object.values(secret.stdio?.env || {}),
    ])
    .filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
  return redactValues(value, values);
}
