import type { ActivityPage } from "./activityView";

export type ActivityHistoryState = {
  loading: boolean;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  error: string;
};

// One loader per conversation/source generation. Snapshot, live updates and
// requested history have independent cursors, so an old page never rewinds sync.
export class ActivityHistory {
  private stopped = false;
  private initialized = false;
  private supportsPaging = false;
  private cursor = 0;
  private before: number | null = null;
  private legacyBefore: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private refreshing: Promise<void> | null = null;
  private again = false;
  private runs: string[] = [];
  private loadedRuns = new Set<string>();
  private state: ActivityHistoryState = {
    loading: true,
    hasEarlier: false,
    loadingEarlier: false,
    error: "",
  };

  constructor(
    private base: `/conversations/${string}/activities` | `/runs/${string}/activities`,
    private fetch: (url: `/conversations/${string}/activities?${string}` | `/runs/${string}/activities?${string}`) => Promise<ActivityPage>,
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
      hasEarlier: this.before !== null || this.legacyBefore !== null,
    };
    if (!this.stopped) this.changed(this.state);
  }

  private enqueue(job: () => Promise<void>) {
    const work = this.queue.then(async () => {
      if (this.stopped) return;
      try {
        await job();
        this.publish({ error: "" });
      } catch (error) {
        this.publish({
          error:
            error instanceof Error
              ? error.message
              : "Activity could not be loaded",
        });
      }
    });
    this.queue = work;
    return work;
  }

  private async page(query: string) {
    if (this.stopped) return null;
    const page = await this.fetch(`${this.base}?${query}`);
    if (this.stopped) return null;
    this.receive(page);
    return page;
  }

  refresh() {
    // A change signalled while a read is in flight must not be dropped: follow
    // that read with one more pass instead of waiting for the next poll.
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = this.enqueue(async () => {
      if (!this.initialized) {
        const page = await this.page(
          this.tools ? "view=recent" : "view=recent&tools=0",
        );
        if (!page) return;
        this.supportsPaging = "earlier" in page;
        this.cursor = page.cursor;
        this.before = page.earlier ?? null;
        this.legacyBefore = page.legacyAvailable
          ? Number.MAX_SAFE_INTEGER
          : null;
        // Older desktops return the original forward-paged snapshot. Preserve
        // that contract until the server also supports recent snapshots.
        let current = page;
        while (current.more && !this.stopped) {
          const next = await this.page(
            `view=updates${this.tools ? "" : "&tools=0"}&after=${this.cursor}`,
          );
          if (!next) return;
          this.cursor = next.cursor;
          current = next;
        }
        this.initialized = true;
      } else {
        let page: ActivityPage | null;
        do {
          page = await this.page(
            `view=updates${this.tools ? "" : "&tools=0"}&after=${this.cursor}`,
          );
          if (!page) return;
          this.cursor = page.cursor;
        } while (page.more && !this.stopped);
      }
      await this.files();
    }).finally(() => {
      this.publish({ loading: false });
      this.refreshing = null;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.refreshing;
  }

  setRuns(runs: string[]) {
    this.runs = [...new Set(runs)];
    return this.enqueue(() => this.files());
  }

  private async files() {
    if (!this.initialized || !this.supportsPaging) return;
    const missing = this.runs.filter((run) => !this.loadedRuns.has(run));
    for (let i = 0; i < missing.length && !this.stopped; i += 50) {
      const batch = missing.slice(i, i + 50);
      let after = 0;
      let page: ActivityPage | null;
      do {
        page = await this.page(
          `view=files&runs=${encodeURIComponent(batch.join(","))}&after=${after}`,
        );
        if (!page) return;
        after = page.cursor;
      } while (page.more && !this.stopped);
      batch.forEach((run) => this.loadedRuns.add(run));
    }
  }

  loadEarlier() {
    if (this.state.loadingEarlier) return this.queue;
    this.publish({ loadingEarlier: true });
    return this.enqueue(async () => {
      if (this.before !== null) {
        const page = await this.page(`view=recent&before=${this.before}`);
        if (page) this.before = page.earlier ?? null;
      } else if (this.legacyBefore !== null) {
        const page = await this.page(`view=legacy&before=${this.legacyBefore}`);
        if (page) this.legacyBefore = page.earlier ?? null;
      }
    }).finally(() => this.publish({ loadingEarlier: false }));
  }
}
