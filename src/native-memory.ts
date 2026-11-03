import type { ChildProcess } from "node:child_process";
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Only OS evidence from this launch's dedicated scope may create this error. */
export class NativeMemoryError extends Error {
  readonly code = "native_memory_limit";
  constructor(
    readonly limitBytes?: number,
    readonly shared = false,
  ) {
    const valid = Number.isSafeInteger(limitBytes) && limitBytes! > 0;
    const unit = valid && limitBytes! >= 1024 ** 3 ? "GiB" : "MiB";
    const amount = valid
      ? Number((limitBytes! / 1024 ** (unit === "GiB" ? 3 : 2)).toFixed(1))
      : undefined;
    super(
      `Out of memory. The execution host killed this agent or one of its commands.${amount ? ` The configured limit is ${amount} ${unit}${shared ? ", shared across agents" : ""}.` : ""} Review saved progress, then retry when fewer builds or tests are running.`,
    );
    this.name = "NativeMemoryError";
  }
}

export function nativeFailureDetail(error: unknown, fallback: string) {
  return error instanceof NativeMemoryError ? error.message : fallback;
}

const monitors = new WeakMap<ChildProcess, NativeMemoryMonitor>();
export function observeNativeMemory(
  child: ChildProcess,
  roots?: { proc: string; cgroups: string },
) {
  if (process.platform === "linux" && child.pid)
    monitors.set(child, new NativeMemoryMonitor(child, roots));
}
export function nativeMemoryFailure(child: ChildProcess) {
  return monitors.get(child)?.failure();
}

/** Watch before exit: systemd may remove a failed scope immediately afterward.
 * Never use the parent slice's counters: another agent may have exhausted it.
 * Roots are injectable for filesystem fixtures, never taken from environment,
 * native output, browser requests or provider diagnostics. */
export class NativeMemoryMonitor {
  private scope?: string;
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private observedKills = 0;
  private evidence?: { at: number; error: NativeMemoryError };
  private readonly started = performance.now();
  constructor(
    private readonly child: ChildProcess,
    private readonly roots = { proc: "/proc", cgroups: "/sys/fs/cgroup" },
  ) {
    child.once("exit", () => this.stop());
    child.once("error", () => this.stop());
    this.locate();
    if (!this.scope && !this.stopped)
      this.timer = setInterval(() => this.locate(), 100).unref();
  }
  private locate() {
    if (this.stopped) return;
    if (performance.now() - this.started > 20_000) {
      this.stop();
      return;
    }
    try {
      const group = readFileSync(
        join(this.roots.proc, String(this.child.pid), "cgroup"),
        "utf8",
      )
        .split("\n")
        .find((line) => line.startsWith("0::"))
        ?.slice(3);
      if (
        !group?.startsWith("/") ||
        group.split("/").includes("..") ||
        !group.includes("/loop-agents.slice/") ||
        !new RegExp(`^loop-agent-${this.child.pid}-[a-f0-9]{32}\\.scope$`).test(
          basename(group),
        )
      )
        return;
      this.scope = join(this.roots.cgroups, group.slice(1));
      clearInterval(this.timer);
      this.sample();
      // cgroup v2 emits modification events when these counters change. A slow
      // poll also handles hosts whose filesystem watcher cannot be installed.
      this.timer = setInterval(() => this.sample(), 1000).unref();
      try {
        this.watcher = watch(
          join(this.scope, "memory.events"),
          { persistent: false },
          () => this.sample(),
        );
        this.watcher.on("error", () => this.watcher?.close());
      } catch {
        /* optional diagnostics must never prevent a native launch */
      }
    } catch {
      /* process may still be entering its scope, or already gone */
    }
  }
  private sample() {
    if (!this.scope || this.stopped) return;
    try {
      const counters = readFileSync(join(this.scope, "memory.events"), "utf8");
      let kills = 0;
      for (const line of counters.split("\n")) {
        const match = /^(oom_kill|oom_group_kill) (\d+)$/.exec(line.trim());
        if (match) kills += Number(match[2]);
      }
      if (kills <= this.observedKills) return;
      this.observedKills = kills;
      let limit: number | undefined;
      let shared = false;
      for (
        let group = this.scope;
        group !== this.roots.cgroups;
        group = dirname(group)
      ) {
        if (group === dirname(group)) break;
        try {
          const value = readFileSync(join(group, "memory.max"), "utf8").trim();
          const bytes = /^\d+$/.test(value) ? Number(value) : NaN;
          if (
            Number.isSafeInteger(bytes) &&
            bytes > 0 &&
            (limit === undefined || bytes < limit)
          ) {
            limit = bytes;
            shared = group !== this.scope;
          }
        } catch {
          /* a finite limit is useful, but not required to report a kill */
        }
      }
      this.evidence = {
        at: performance.now(),
        error: new NativeMemoryError(limit, shared),
      };
    } catch {
      /* keep recent evidence after the scope has been collected */
    }
  }
  failure() {
    this.sample();
    // A tool can survive an earlier OOM under a custom continue policy. Do not
    // blame a much later, unrelated process exit on that historical event.
    return this.evidence && performance.now() - this.evidence.at < 10_000
      ? this.evidence.error
      : undefined;
  }
  private stop() {
    if (this.stopped) return;
    this.sample();
    this.stopped = true;
    clearInterval(this.timer);
    this.watcher?.close();
  }
}
