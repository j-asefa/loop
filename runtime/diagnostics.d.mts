export function diagnosticText(value: unknown, secrets?: unknown[]): string;
export function errorFacts(error: unknown): {
  type: string;
  code?: string | number;
  causes?: (string | number)[];
  status?: number;
};
export function errorSummary(
  error: unknown,
  secrets?: unknown[],
  includeMessage?: boolean,
): string;
export class RuntimeFailure extends Error {
  constructor(message: string, details?: Record<string, unknown>);
  details: Record<string, unknown>;
}
export function runtimeFailureFacts(
  details: unknown,
): Record<string, string | number>;
