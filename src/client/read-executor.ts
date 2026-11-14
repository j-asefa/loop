export type ReadMode = "automatic" | "manual";
export type ReadState = { error: string; busy: boolean; failure: unknown };
type ReadCompletion =
  | { status: "cancelled" }
  | { status: "success"; current: () => boolean }
  | { status: "error"; error: unknown; current: () => boolean };

export function createReadExecutor(options: {
  current(): boolean;
  changed(state: ReadState): void;
}) {
  const context = {
    controller: undefined as AbortController | undefined,
    active: true,
    running: false,
    queued: undefined as (() => Promise<ReadCompletion>) | undefined,
    priority: 0,
    epoch: 0,
    waiters: [] as ((completion: ReadCompletion) => void)[],
  };
  let state: ReadState = { error: "", busy: false, failure: undefined };
  const publish = (value: ReadState) => {
    state = value;
    options.changed(value);
  };
  function cancelIO() {
    context.epoch++;
    context.controller?.abort();
    context.controller = undefined;
    context.running = false;
    context.queued = undefined;
    context.priority = 0;
    context.waiters
      .splice(0)
      .forEach((resolve) => resolve({ status: "cancelled" }));
  }
  function cancel() {
    if (!context.active || !options.current()) return false;
    cancelIO();
    publish({ error: "", busy: false, failure: undefined });
    return true;
  }
  async function execute<T>(
    read: (signal: AbortSignal, mode: ReadMode) => Promise<T>,
    receive: (value: T) => void,
    manual = false,
    priority = 0,
  ): Promise<ReadCompletion> {
    if (!context.active || !options.current()) return { status: "cancelled" };
    // Recovery or event bursts must let a healthy slow read finish. Keep
    // one trailing refresh so changes during that read are not lost.
    if (context.running && !manual) {
      if (!context.queued || priority >= context.priority) {
        context.queued = () => execute(read, receive, false, priority);
        context.priority = priority;
      }
      return new Promise((resolve) => context.waiters.push(resolve));
    }
    context.queued = undefined;
    context.waiters
      .splice(0)
      .forEach((resolve) => resolve({ status: "cancelled" }));
    context.running = true;
    context.controller?.abort();
    const controller = new AbortController();
    context.controller = controller;
    const epoch = context.epoch;
    const scopeCurrent = () =>
      context.active && context.epoch === epoch && options.current();
    const current = () =>
      scopeCurrent() &&
      !controller.signal.aborted &&
      context.controller === controller;
    publish({ error: state.error, failure: state.failure, busy: true });
    try {
      if (!current()) return { status: "cancelled" };
      const value = await read(
        controller.signal,
        manual ? "manual" : "automatic",
      );
      if (!current()) return { status: "cancelled" };
      receive(value);
      if (current()) publish({ error: "", busy: false, failure: undefined });
      return { status: "success", current: scopeCurrent };
    } catch (error) {
      if (!current()) return { status: "cancelled" };
      publish({
        failure: error,
        error:
          error instanceof Error
            ? error.message
            : "The workspace is unavailable.",
        busy: false,
      });
      return { status: "error", error, current: scopeCurrent };
    } finally {
      if (context.controller === controller) {
        context.running = false;
        // Another load can queue a refresh across the await above.
        const queued = context.queued as
          (() => Promise<ReadCompletion>) | undefined;
        context.queued = undefined;
        const waiters = context.waiters.splice(0);
        if (current() && queued)
          void queued().then((completion) =>
            waiters.forEach((resolve) => resolve(completion)),
          );
        else waiters.forEach((resolve) => resolve({ status: "cancelled" }));
      }
    }
  }
  async function load<T>(
    read: (signal: AbortSignal, mode: ReadMode) => Promise<T>,
    receive: (value: T) => void,
    manual = false,
    priority = 0,
  ): Promise<void> {
    await execute(read, receive, manual, priority);
  }
  return {
    load,
    execute,
    cancel,
    isBusy: () => context.running,
    activate() {
      context.active = true;
    },
    dispose() {
      context.active = false;
      cancelIO();
    },
  };
}
