// Claude Code reads a user message written during a turn at its next tool
// boundary and answers it inside that turn, so Loop never interrupts a turn to
// deliver a follow-up. With --replay-user-messages Claude echoes each message,
// with the uuid Loop sent, when it reads it; that echo is the delivery receipt.
// If the turn ends before Claude reads the follow-up, Claude emits that turn's
// result, then the echo, then answers in a further turn. It does this after an
// interrupt too. A result that arrives while a follow-up is unread is held, so
// the Loop run stays open for that further turn; if no echo follows within
// HOLD_MS, the run ends with the held result and the follow-up is unconfirmed.
// Both behaviours were observed on Claude Code 2.1.237 and 2.1.325.
type Waiter = { resolve: () => void; reject: (error: Error) => void };

export const HOLD_MS = 10_000;

export class ClaudeSteering {
  private unread = new Map<string, Waiter>();
  private given = new Set<string>();
  private errors: string[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  /** Resolves when Claude echoes the message with this uuid. */
  expect(uuid: string) {
    return new Promise<void>((resolve, reject) => {
      this.unread.set(uuid, { resolve, reject });
    });
  }
  /** Settles the follow-up Claude just read; false for other echoes. */
  read(uuid: unknown) {
    if (typeof uuid !== "string") return false;
    const waiter = this.unread.get(uuid);
    if (!waiter) return false;
    this.unread.delete(uuid);
    clearTimeout(this.timer);
    this.timer = undefined;
    waiter.resolve();
    return true;
  }
  /** Forgets a follow-up whose write failed; it settles nothing. */
  drop(uuid: string) {
    this.unread.delete(uuid);
  }
  get pending() {
    return this.unread.size > 0;
  }
  /** Holds a turn's result while a follow-up is unread. */
  hold(result: { errors?: string[] }, fallback: () => void) {
    this.errors.push(...(result.errors ?? []));
    clearTimeout(this.timer);
    this.timer = setTimeout(fallback, HOLD_MS);
  }
  /** Ends holding; returns the errors of the turns that were held. */
  release() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const errors = this.errors;
    this.errors = [];
    return errors;
  }
  /** Whether this echo is a follow-up Loop already gave up on. */
  abandoned(uuid: unknown) {
    return typeof uuid === "string" && this.given.delete(uuid);
  }
  /** The outcome of every unread follow-up is now unknown; none is resent. */
  abandon(detail: string) {
    this.release();
    for (const [uuid, waiter] of this.unread) {
      this.given.add(uuid);
      waiter.reject(new Error(detail));
    }
    this.unread.clear();
  }
}
