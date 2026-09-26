// Transport heartbeats are not progress. Call progress only for provider output.
export class IdleTimeoutError extends Error {}
export const TURN_IDLE_MS = 60 * 60_000;
export const IDLE_TIMEOUT_MESSAGE = `The native run produced no progress for ${TURN_IDLE_MS / 60_000} minutes and was stopped. Long commands that emit no provider output, including builds or CI waits, also reach this limit. Partial work is saved; inspect it before retrying.`;
export function idleDeadline(onTimeout) {
  let timer,
    closed = false;
  const progress = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      closed = true;
      onTimeout(new IdleTimeoutError(IDLE_TIMEOUT_MESSAGE));
    }, TURN_IDLE_MS);
  };
  progress();
  return {
    progress,
    clear() {
      closed = true;
      clearTimeout(timer);
    },
  };
}
