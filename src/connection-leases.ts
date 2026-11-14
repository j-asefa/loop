import { randomBytes } from "node:crypto";
import { equalSecret } from "./local-control.js";
import { probeProof, type Hello } from "./connection.js";
import { secret } from "./state.js";

type Identity = { generation: number; lease: string };
type Backend = Identity & { path: string; seen: number };
type Input = { generation?: unknown; lease?: unknown; socket?: unknown };
type Reply = [
  number,
  { error?: string; registered?: boolean; withdrawn?: boolean },
];

const owns = (input: Input, entry?: Identity) =>
  !!entry &&
  input.generation === entry.generation &&
  typeof input.lease === "string" &&
  equalSecret(input.lease, entry.lease);

/** Owns application lease decisions; the service owns transport and scheduling. */
export class ConnectionLeases {
  private generation = 0;
  private pending?: Identity;
  private backend?: Backend;
  // The latest launch after silence or refusal, recoverable until a new lease.
  private lapsed?: Identity;
  private since: number;

  constructor(
    private readonly instance: string,
    startedAt: number,
    private readonly dependencies: {
      now: () => number;
      timeout: number;
      socket: (name: unknown) => string | undefined;
      probe: (path: string, nonce: string) => Promise<string>;
      setBackend: (
        backend: { generation: number; path: string } | undefined,
      ) => void;
      log: (message: string) => void;
    },
  ) {
    this.since = startedAt;
  }

  status(): Hello["backend"] {
    return {
      generation:
        this.backend?.generation ?? this.pending?.generation ?? this.generation,
      state: this.backend ? "ready" : this.pending ? "pending" : "none",
      since: this.since,
    };
  }

  lease(): Identity {
    this.detach("was replaced by a new launch");
    this.lapsed = undefined;
    this.pending = { generation: ++this.generation, lease: secret() };
    return { ...this.pending };
  }

  async register(input: Input): Promise<Reply> {
    const entry = owns(input, this.pending)
      ? this.pending
      : owns(input, this.lapsed)
        ? this.lapsed
        : undefined;
    if (!entry)
      return [409, { error: "Stale or unknown application generation." }];
    const path = this.dependencies.socket(input.socket);
    if (!path) return [400, { error: "Invalid application socket." }];
    const nonce = randomBytes(24).toString("base64url");
    const proof = await this.dependencies.probe(path, nonce).catch(() => "");
    // A newer lease or withdrawal can win while the probe is in flight.
    if (
      (entry === this.pending
        ? !owns(input, this.pending)
        : !owns(input, this.lapsed)) ||
      !equalSecret(
        proof,
        probeProof(entry.lease, this.instance, entry.generation, nonce),
      )
    )
      return [409, { error: "Application socket failed verification." }];
    this.backend = {
      generation: entry.generation,
      lease: entry.lease,
      path,
      seen: this.dependencies.now(),
    };
    this.since = this.dependencies.now();
    if (entry === this.pending) this.pending = undefined;
    this.lapsed = undefined;
    // Publish synchronously with the decision: a second probe continuation
    // must not allow an older caller to attach after the newer lease wins.
    this.dependencies.setBackend({ generation: this.backend.generation, path });
    this.dependencies.log(
      `Application generation ${this.backend.generation} registered; forwarding resumed.`,
    );
    return [200, {}];
  }

  heartbeat(input: Input): Reply {
    if (owns(input, this.backend)) this.backend!.seen = this.dependencies.now();
    else if (!owns(input, this.pending) && !owns(input, this.lapsed))
      return [409, { error: "Stale application generation." }];
    return [200, { registered: owns(input, this.backend) }];
  }

  withdraw(input: Input): Reply {
    if (owns(input, this.pending)) this.pending = undefined;
    else if (owns(input, this.lapsed)) this.lapsed = undefined;
    else if (owns(input, this.backend)) this.detach("is stopping");
    else return [409, { error: "Stale application generation." }];
    return [200, { withdrawn: true }];
  }

  unreachable(generation: number) {
    if (this.backend?.generation === generation)
      this.detach("stopped accepting connections", true);
  }

  expire() {
    if (
      this.backend &&
      this.dependencies.now() - this.backend.seen > this.dependencies.timeout
    )
      this.detach("stopped sending heartbeats", true);
  }

  private detach(reason: string, recoverable = false) {
    if (!this.backend) return;
    this.dependencies.log(
      `Application generation ${this.backend.generation} ${reason}; requests receive 503 until a launch registers.`,
    );
    this.lapsed = recoverable
      ? { generation: this.backend.generation, lease: this.backend.lease }
      : undefined;
    this.backend = undefined;
    this.since = this.dependencies.now();
    this.dependencies.setBackend(undefined);
  }
}
