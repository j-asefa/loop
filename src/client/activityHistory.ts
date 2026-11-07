import type { ActivityPage } from "./activityView";
import type { ReadMode } from "./api";
import type { RouteInput, workspaceApi } from "../shared/workspace-api";
export type ActivityHistoryQuery = RouteInput<
  typeof workspaceApi.conversationActivities
>["query"];

export type ActivityHistoryState = {
  loading: boolean;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  error: string;
};
type ReadOperation = "refresh" | "files" | "earlier";

// One loader per conversation/source generation. Snapshot, live updates and
// requested history have independent cursors, so an old page never rewinds sync.
export class ActivityHistory {
  private stopped = false;
  private initialized = false;
  private cursor = 0;
  private before: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private refreshing: Promise<void> | null = null;
  private again = false;
  private runs: string[] = [];
  private loadedRuns = new Set<string>();
  // A successful live or file read cannot recover a failed earlier page.
  private failedReads = new Map<
    ReadOperation,
    { retry: () => Promise<void>; error: string }
  >();
  private retrying: Promise<void> | null = null;
  private state: ActivityHistoryState = {
    loading: true,
    hasEarlier: false,
    loadingEarlier: false,
    error: "",
  };

  constructor(
    private fetch: (
      query: ActivityHistoryQuery,
      mode: ReadMode,
    ) => Promise<ActivityPage>,
    private receive: (page: ActivityPage) => void,
    private changed: (state: ActivityHistoryState) => void,
    private tools = true,
  ) {}

  stop() {
    this.stopped = true;
  }

  private publish(patch: Partial<ActivityHistoryState> = {}) {
    this.state = {
      ...this.state,
      ...patch,
      hasEarlier: this.before !== null,
    };
    if (!this.stopped) this.changed(this.state);
  }

  retry() {
    if (this.retrying) return this.retrying;
    const failed = this.failedReads.values().next().value;
    if (!failed) return;
    this.publish({ loading: true });
    this.retrying = failed.retry().finally(() => {
      this.retrying = null;
      this.publish({ loading: !!this.refreshing });
    });
    return this.retrying;
  }

  private async attempt(
    operation: ReadOperation,
    job: () => Promise<void>,
    retry: () => Promise<void>,
  ) {
    if (this.stopped) return;
    try {
      await job();
      this.failedReads.delete(operation);
      this.publish({
        error: this.failedReads.values().next().value?.error || "",
      });
    } catch (error) {
      this.failedReads.set(operation, {
        retry,
        error:
          error instanceof Error
            ? error.message
            : "Activity could not be loaded",
      });
      this.publish({ error: this.failedReads.values().next().value!.error });
    }
  }

  private enqueue(
    operation: ReadOperation,
    job: () => Promise<void>,
    retry: () => Promise<void>,
  ) {
    const work = this.queue.then(() => this.attempt(operation, job, retry));
    this.queue = work;
    return work;
  }

  private async page(query: ActivityHistoryQuery, manual = false) {
    if (this.stopped) return null;
    const page = await this.fetch(query, manual ? "manual" : "automatic");
    if (this.stopped) return null;
    this.receive(page);
    return page;
  }

  refresh(manual = false, background = false): Promise<void> {
    // A change signalled while a read is in flight must not be dropped: follow
    // that read with one more pass instead of waiting for the next poll.
    if (this.refreshing) {
      if (!background) this.again = true;
      return this.refreshing;
    }
    if (manual || this.state.error)
      this.publish({
        error: manual || background ? this.state.error : "",
        loading: true,
      });
    this.refreshing = this.enqueue(
      "refresh",
      async () => {
        if (!this.initialized) {
          const page = await this.page(
            {
              view: "recent",
              ...(this.tools ? {} : { tools: "0" }),
            },
            manual,
          );
          if (!page) return;
          this.cursor = page.cursor;
          this.before = page.earlier ?? null;
          this.initialized = true;
        } else {
          let page: ActivityPage | null;
          do {
            page = await this.page(
              {
                view: "updates",
                ...(this.tools ? {} : { tools: "0" }),
                after: String(this.cursor),
              },
              manual,
            );
            if (!page) return;
            this.cursor = page.cursor;
          } while (page.more && !this.stopped);
        }
        await this.attempt(
          "files",
          () => this.files(manual),
          () => this.setRuns(this.runs, true),
        );
      },
      () => this.refresh(true),
    ).finally(() => {
      this.refreshing = null;
      this.publish({ loading: !!this.retrying });
      if (this.again && !this.stopped) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.refreshing;
  }

  setRuns(runs: string[], manual = false): Promise<void> {
    this.runs = [...new Set(runs)];
    return this.enqueue(
      "files",
      () => this.files(manual),
      () => this.setRuns(this.runs, true),
    );
  }

  private async files(manual = false) {
    if (!this.initialized) return;
    const missing = this.runs.filter((run) => !this.loadedRuns.has(run));
    for (let i = 0; i < missing.length && !this.stopped; i += 50) {
      const batch = missing.slice(i, i + 50);
      let after = 0;
      let page: ActivityPage | null;
      do {
        page = await this.page(
          {
            view: "files",
            runs: batch.join(","),
            after: String(after),
          },
          manual,
        );
        if (!page) return;
        after = page.cursor;
      } while (page.more && !this.stopped);
      batch.forEach((run) => this.loadedRuns.add(run));
    }
  }

  loadEarlier(manual = false): Promise<void> {
    if (this.state.loadingEarlier) return this.queue;
    this.publish({ loadingEarlier: true });
    return this.enqueue(
      "earlier",
      async () => {
        if (this.before !== null) {
          const page = await this.page(
            {
              view: "recent",
              before: String(this.before),
            },
            manual,
          );
          if (page) this.before = page.earlier ?? null;
        }
      },
      () => this.loadEarlier(true),
    ).finally(() => this.publish({ loadingEarlier: false }));
  }
}
