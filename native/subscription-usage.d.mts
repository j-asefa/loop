export function claudeUsageFile(configDir: string): string;
export function captureClaudeUsage(input: string, file: string): Promise<boolean>;
export function readClaudeUsage(file: string): Promise<{
  status: "cached" | "unavailable";
  observedAt?: string;
  fiveHour?: { usedPercent: number; resetsAt: string | null } | null;
  sevenDay?: { usedPercent: number; resetsAt: string | null } | null;
}>;
export function configureClaudeUsage(configDir: string, hookPath: string): boolean;
export function readCodexUsage(options: {
  endpoint?: string;
  token?: string;
  WebSocketCtor?: unknown;
  timeoutMs?: number;
}): Promise<Record<string, unknown>>;
