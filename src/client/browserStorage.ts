// Optional UI persistence may fail without invalidating an accepted action or
// an in-memory draft. Command identities must use storage that throws on failure.
export function withOptionalStorage<T>(
  kind: "local" | "session",
  operation: (storage: Storage) => T,
  fallback: T,
): T {
  try {
    return operation(kind === "local" ? localStorage : sessionStorage);
  } catch {
    return fallback;
  }
}
