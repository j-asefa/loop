// Claude's streaming input queues ordinary user messages. Interrupt its current
// generation, wait for its terminal result, then resume the same native session.
// No tool call or original prompt is replayed by Loop.
export class ClaudeSteering {
  waiting;
  async steer(text, interrupt, prompt) {
    if (this.waiting) throw new Error("A follow-up is already being delivered");
    let resolve;
    const stopped = new Promise((yes) => {
      resolve = yes;
    });
    this.waiting = { resolve };
    let timer;
    try {
      await Promise.race([
        (async () => {
          await interrupt();
          await stopped;
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Claude interruption was not confirmed")),
            10000,
          );
        }),
      ]);
      this.waiting = undefined;
      await prompt(text);
    } finally {
      clearTimeout(timer);
      this.waiting = undefined;
    }
  }
  result() {
    if (!this.waiting) return false;
    this.waiting.resolve();
    return true;
  }
}
