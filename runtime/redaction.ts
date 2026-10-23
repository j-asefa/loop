export function redactValues(value: string, values: unknown[]): string;
export function redactValues(value: unknown, values: unknown[]): unknown;
export function redactValues(value: unknown, values: unknown[]): unknown {
  const sensitive = [
    ...new Set(
      values
        .filter(
          (item): item is string => typeof item === "string" && item.length > 0,
        )
        .flatMap((item) => [
          item,
          encodeURIComponent(item),
          new URLSearchParams({ key: item }).toString().slice(4),
        ]),
    ),
  ].sort((a, b) => b.length - a.length);
  if (!sensitive.length) return value;
  const text = (input: string) =>
    sensitive.reduce(
      (result, item) => result.split(item).join("[redacted]"),
      input,
    );
  function redact(input: unknown): unknown {
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
