// A control request belongs to one runtime invocation, never just an account.
// Keep receipts until that invocation exits so retries cannot inject twice.
export class SteeringControls {
  pending = new Map<
    string,
    {
      text: string;
      promise: Promise<{ accepted: boolean }>;
      resolve: (value: { accepted: boolean }) => void;
      reject: (error: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  declare write: (message: { action: string; id: string; text: string }) => void;
  constructor(
    write: (message: { action: string; id: string; text: string }) => void,
  ) {
    this.write = write;
  }
  send(id: string, text: string): Promise<{ accepted: boolean }> {
    const prior = this.pending.get(id);
    if (prior) {
      if (prior.text !== text)
        return Promise.reject(new Error("Input ID reused"));
      return prior.promise;
    }
    let resolve!: (value: { accepted: boolean }) => void,
      reject!: (error: unknown) => void;
    const promise = new Promise<{ accepted: boolean }>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const timer = setTimeout(
      () => reject(new Error("Steering outcome unknown")),
      15000,
    );
    const receipt = { text, promise, resolve, reject, timer };
    this.pending.set(id, receipt);
    try {
      this.write({ action: "steer", id, text });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
    return promise;
  }
  receive(receipt: { id: string; accepted: boolean }) {
    const pending = this.pending.get(receipt?.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    receipt.accepted
      ? pending.resolve({ accepted: true })
      : pending.reject(new Error("Native turn did not accept the follow-up"));
  }
  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Runtime ended before confirming delivery"));
    }
  }
}

export function receiveSteering(
  iterator: AsyncIterator<string>,
  emit: (message: {
    steeringResult: { id: unknown; accepted: boolean };
  }) => void,
  deliver: (text: string, id: string) => Promise<unknown>,
): () => void {
  let open = true;
  void (async () => {
    while (open) {
      const next = await iterator.next();
      if (next.done || !open) break;
      let request;
      try {
        request = JSON.parse(next.value);
        if (
          request.action !== "steer" ||
          typeof request.id !== "string" ||
          request.id.length > 150 ||
          typeof request.text !== "string" ||
          !request.text.trim() ||
          request.text.length > 500000
        )
          throw new Error("Invalid input");
        await deliver(request.text, request.id);
        emit({ steeringResult: { id: request.id, accepted: true } });
      } catch {
        emit({ steeringResult: { id: request?.id, accepted: false } });
      }
    }
  })().catch(() => {});
  return () => {
    open = false;
  };
}
