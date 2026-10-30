export const FLEET_CAPACITY = Object.freeze({
  managed: 160,
  inboundPeers: 64,
  browserReserve: 32,
  outbound: 32,
  outboundEvents: 24,
  perDestination: 4,
});
type Kind = "browser" | "peer" | "outbound";

/** One companion's shared admission, including long-lived sockets. Every
 * caller holds its slot until IO has finished; nothing queues, retries or
 * aborts accepted work to make room. A fleet of one keeps browser admission
 * unchanged, while the new peer surfaces remain bounded. */
export class FleetCapacity {
  private counts: Record<Kind, number> = { browser: 0, peer: 0, outbound: 0 };
  private destinations = new Map<string, number>();
  private eventDestinations = new Set<string>();
  private setups = new Map<Kind, { tokens: number; at: number }>();
  private cooldowns = new Map<string, number>();
  constructor(private readonly enabled: () => boolean) {}

  defer(destination: string, milliseconds: number) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
    const now = performance.now();
    for (const [key, until] of this.cooldowns)
      if (until <= now) this.cooldowns.delete(key);
    if (!this.cooldowns.has(destination) && this.cooldowns.size >= 256)
      this.cooldowns.delete(this.cooldowns.keys().next().value!);
    this.cooldowns.set(
      destination,
      Math.max(
        this.cooldowns.get(destination) ?? 0,
        now + Math.min(300_000, milliseconds),
      ),
    );
  }
  retryAfter(destination: string) {
    return Math.max(
      0,
      (this.cooldowns.get(destination) ?? 0) - performance.now(),
    );
  }

  /** One shared event stream per peer leaves three destination slots for HTTP;
   * the global event bound also leaves eight outbound slots for finite IO. */
  acquireEvent(destination: string): (() => void) | undefined {
    if (
      this.eventDestinations.has(destination) ||
      this.eventDestinations.size >= FLEET_CAPACITY.outboundEvents
    )
      return;
    const release = this.acquire("outbound", destination);
    if (!release) return;
    this.eventDestinations.add(destination);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.eventDestinations.delete(destination);
      release();
    };
  }

  /** A fixed-size token bucket bounds connection churn as well as open IO.
   * Browser setup in a single-machine workspace keeps its existing behavior. */
  connection(kind: Kind, now = performance.now()): boolean {
    if (kind === "browser" && !this.enabled()) return true;
    const bucket = this.setups.get(kind) ?? { tokens: 32, at: now };
    bucket.tokens = Math.min(
      32,
      bucket.tokens + Math.max(0, now - bucket.at) * 0.008,
    );
    bucket.at = now;
    this.setups.set(kind, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens--;
    return true;
  }

  snapshot() {
    const { browser, peer, outbound } = this.counts;
    return {
      enabled: this.enabled(),
      browser,
      peer,
      outbound,
      total: browser + peer + outbound,
    };
  }
  /** Advisory only: authorization and the next admission still run normally. */
  availablePeers() {
    const current = this.snapshot();
    return Math.max(
      0,
      Math.min(
        FLEET_CAPACITY.inboundPeers - current.peer,
        FLEET_CAPACITY.managed - current.total,
        FLEET_CAPACITY.managed -
          FLEET_CAPACITY.browserReserve -
          current.peer -
          current.outbound,
      ),
    );
  }
  acquire(kind: Kind, destination?: string): (() => void) | undefined {
    const current = this.snapshot();
    if (kind !== "browser" || current.enabled) {
      if (current.total >= FLEET_CAPACITY.managed) return;
      if (
        kind !== "browser" &&
        current.peer + current.outbound >=
          FLEET_CAPACITY.managed - FLEET_CAPACITY.browserReserve
      )
        return;
      if (kind === "peer" && current.peer >= FLEET_CAPACITY.inboundPeers)
        return;
      if (
        kind === "outbound" &&
        (!destination ||
          this.retryAfter(destination) > 0 ||
          current.outbound >= FLEET_CAPACITY.outbound ||
          (this.destinations.get(destination) ?? 0) >=
            FLEET_CAPACITY.perDestination)
      )
        return;
    }
    this.counts[kind]++;
    if (kind === "outbound")
      this.destinations.set(
        destination!,
        (this.destinations.get(destination!) ?? 0) + 1,
      );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.counts[kind]--;
      if (kind === "outbound") {
        const remaining = this.destinations.get(destination!)! - 1;
        if (remaining) this.destinations.set(destination!, remaining);
        else this.destinations.delete(destination!);
      }
    };
  }
}
