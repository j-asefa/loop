export function projectionConfig(
  rpc: { call(method: string, params: object): Promise<any> },
  cwd?: string,
): Promise<Record<string, unknown>>;
export function projectionDefaultModel(
  rpc: { call(method: string, params: object): Promise<any> },
  cwd: string,
): Promise<string>;
export function projectionRefusal(): {
  error: { code: number; message: string };
};
export const claudeProjectionArgs: string[];
export function assertProjectionThread(thread: unknown): void;
