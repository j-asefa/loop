import {
  isUncertainOutcomeError,
  LoopApiError,
  randomUuid,
} from "./api/client";

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Durable per-target idempotency/command key store so retries after uncertain
 * timeouts reuse the exact same key while different choices or workspaces get fresh keys.
 */
export class ActionKeyStore {
  private keys = new Map<string, string>();
  private makeKey: () => string;

  constructor(makeKey: () => string = randomUuid) {
    this.makeKey = makeKey;
  }

  scopeForApproval(id: string, decision: "approve" | "reject"): string {
    return `approval:${id}:${decision}`;
  }

  scopeForDecision(id: string, answer: Record<string, unknown>): string {
    return `decision:${id}:${stableStringify(answer)}`;
  }

  scopeForRunCancel(runId: string): string {
    return `run-cancel:${runId}`;
  }

  getOrCreate(scopeKey: string): string {
    let key = this.keys.get(scopeKey);
    if (!key) {
      key = this.makeKey();
      this.keys.set(scopeKey, key);
    }
    return key;
  }

  delete(scopeKey: string): void {
    this.keys.delete(scopeKey);
  }

  clear(): void {
    this.keys.clear();
  }
}

/**
 * Executes an optimistic save/unsave toggle with uncertain-outcome preservation:
 * - On timeout / 5xx / network disconnect: keeps optimistic state and triggers a re-read.
 * - On definite 4xx rejection: rolls back optimistic state and rethrows so callers revert too.
 * - On workspace switch mid-flight (generation mismatch): drops stale error handling cleanly.
 */
export async function runSaveToggle(opts: {
  nextSaved: boolean;
  generation: number;
  getGeneration: () => number;
  applyLocal: (saved: boolean) => void;
  commit: () => Promise<unknown>;
  onSuccess: () => void;
  onUncertain: () => void;
  onDefiniteError: (err: unknown) => void;
}): Promise<"committed" | "uncertain" | "stale"> {
  opts.applyLocal(opts.nextSaved);
  try {
    await opts.commit();
    if (opts.generation !== opts.getGeneration()) return "stale";
    opts.onSuccess();
    return "committed";
  } catch (err) {
    if (opts.generation !== opts.getGeneration()) return "stale";
    if (isUncertainOutcomeError(err)) {
      opts.onUncertain();
      return "uncertain";
    }
    opts.applyLocal(!opts.nextSaved);
    opts.onDefiniteError(err);
    throw err;
  }
}

/**
 * Coordinates workspace refresh calls with generation isolation, overlapping-load
 * coalescing, pull-to-refresh spinner propagation, and 401 short-circuiting.
 */
export class WorkspaceLoadCoordinator {
  private generation = 0;
  private inFlight = false;
  private pending: { silent: boolean } | null = null;
  private sessionRefreshed = false;
  private initialLoadDone = false;

  get currentGeneration(): number {
    return this.generation;
  }

  reset(): number {
    this.generation += 1;
    this.inFlight = false;
    this.pending = null;
    this.sessionRefreshed = false;
    this.initialLoadDone = false;
    return this.generation;
  }

  async run(
    options: { silent?: boolean },
    handlers: {
      setRefreshing: (value: boolean) => void;
      refreshSession: () => Promise<unknown>;
      fetchAll: () => Promise<void>;
      onError: (err: unknown) => void;
    },
  ): Promise<void> {
    const silent = options.silent ?? true;
    const gen = this.generation;

    if (this.inFlight) {
      if (!silent) handlers.setRefreshing(true);
      const prev = this.pending;
      this.pending = { silent: (prev?.silent ?? true) && silent };
      return;
    }

    this.inFlight = true;
    const showErrors = !silent || !this.initialLoadDone;
    if (!silent) handlers.setRefreshing(true);

    try {
      if (!this.sessionRefreshed || !silent) {
        try {
          await handlers.refreshSession();
        } catch (refreshErr) {
          if (refreshErr instanceof LoopApiError && refreshErr.status === 401) {
            return;
          }
        }
        if (gen !== this.generation) return;
        this.sessionRefreshed = true;
      }

      await handlers.fetchAll();
      if (gen !== this.generation) return;
      this.initialLoadDone = true;
    } catch (err) {
      if (gen === this.generation && showErrors) {
        handlers.onError(err);
      }
    } finally {
      if (gen === this.generation) {
        this.inFlight = false;
        if (!silent) handlers.setRefreshing(false);
        const next = this.pending;
        this.pending = null;
        if (next) {
          void this.run(next, handlers);
        }
      }
    }
  }
}

/**
 * Decides how an open thread reloads. Only the first load for a conversation
 * replaces the messages with a spinner; later refreshes (after a send or a
 * workspace update) swap content in place and keep the last good messages if
 * they fail. Responses for an earlier request or another conversation are
 * dropped.
 */
export class ThreadRefreshGate {
  private loadedConversationId: string | null = null;
  private seq = 0;

  begin(conversationId: string): { token: number; showSpinner: boolean } {
    this.seq += 1;
    return {
      token: this.seq,
      showSpinner: this.loadedConversationId !== conversationId,
    };
  }

  /** True when the response for `token` should be applied. */
  accept(token: number, conversationId: string): boolean {
    if (token !== this.seq) return false;
    this.loadedConversationId = conversationId;
    return true;
  }

  /** True when a failed request should replace the thread with its error. */
  showError(token: number, conversationId: string): boolean {
    return token === this.seq && this.loadedConversationId !== conversationId;
  }

  /** True when the request for `token` is still the latest one. */
  isLatest(token: number): boolean {
    return token === this.seq;
  }
}
