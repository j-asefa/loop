import type { ChatInput } from "../src/server/providers.js";
export class HarnessError extends Error {}
export type HarnessCommand = {
  name: string;
  token: string;
  kind: string;
  description: string;
  argumentHint?: string;
  disabledReason?: string;
};
export type HarnessCatalog = {
  available: boolean;
  runtime?: string;
  commands: HarnessCommand[];
  message?: string;
};
export function codexCatalog(result: unknown): HarnessCatalog;
export function codexTurn(
  rpc: { call(method: string, params?: object): Promise<any> },
  threadId: string,
  input: ChatInput,
  nativeTools: boolean,
  cwd?: string,
  signal?: AbortSignal,
): Promise<{ turn: { id: string }; review?: boolean }>;
