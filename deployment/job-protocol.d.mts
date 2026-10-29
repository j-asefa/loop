export function signedMessage(
  key: string,
  nonce: string,
  direction: "request" | "response",
  body: Record<string, unknown>,
): { nonce: string; body: Record<string, unknown>; mac: string };
export function verifiedMessage(
  key: string,
  nonce: string,
  direction: "request" | "response",
  message: unknown,
): Record<string, unknown> | undefined;
