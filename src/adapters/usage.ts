export type Tokens = { input_tokens: number; output_tokens: number };

export function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export function codexTokens(value: any): Tokens | undefined {
  const input = tokenCount(value?.inputTokens);
  const output = tokenCount(value?.outputTokens);
  // Cached input and reasoning output are already included in these totals.
  if (input === undefined || output === undefined) return;
  return { input_tokens: input, output_tokens: output };
}

export function claudeTokens(value: any): Tokens | undefined {
  const input = tokenCount(value?.input_tokens);
  const output = tokenCount(value?.output_tokens);
  if (input === undefined || output === undefined) return;
  const total = input + (tokenCount(value.cache_read_input_tokens) ?? 0)
    + (tokenCount(value.cache_creation_input_tokens) ?? 0);
  if (!Number.isSafeInteger(total)) return;
  return { input_tokens: total, output_tokens: output };
}
