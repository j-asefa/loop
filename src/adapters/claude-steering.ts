// Claude Code reads a user message written during a turn at its next tool
// boundary and answers it inside that turn, so Loop never interrupts a turn to
// deliver a follow-up. With --replay-user-messages Claude echoes each message,
// with the uuid Loop sent, when it reads it; that echo is the delivery receipt.
// If the turn ends before Claude reads the follow-up, Claude emits that turn's
// result, then the echo, then answers in a further turn: a result that arrives
// while a follow-up is unread does not end the Loop run.
type Waiter = { resolve: () => void; reject: (error: Error) => void };

export class ClaudeSteering {
  private unread = new Map<string, Waiter>();
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
  /** The outcome of every unread follow-up is now unknown; none is resent. */
  abandon(detail: string) {
    for (const waiter of this.unread.values()) waiter.reject(new Error(detail));
    this.unread.clear();
  }
}
