import type { AuthSecret } from "./client.js";

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
  // Query credentials may be echoed as an authenticated URL. Replace longer
  // values first so an overlapping shorter value cannot expose their suffix.
  const sensitive = [
    ...new Set(
      values.flatMap((item) => [
        item,
        encodeURIComponent(item),
        new URLSearchParams({ key: item }).toString().slice(4),
      ]),
    ),
  ].sort((a, b) => b.length - a.length);
  const text = (input: string) =>
    sensitive.reduce(
      (result, item) => result.split(item).join("[redacted]"),
      input,
    );
  // Work on strings before JSON encoding, including object keys, so quoted or
  // escaped secrets cannot evade redaction or corrupt the serialized result.
  function redact(input: any): any {
    if (typeof input === "string") return text(input);
    if (Array.isArray(input)) return input.map(redact);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input).map(([key, item]) => [text(key), redact(item)]),
      );
    return input;
  }
  return redact(value);
}
