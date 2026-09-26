export class IdleTimeoutError extends Error {}
export const TURN_IDLE_MS: number;
export const IDLE_TIMEOUT_MESSAGE: string;
export function idleDeadline(onTimeout: (error: Error) => void): {
  progress(): void;
  clear(): void;
};
