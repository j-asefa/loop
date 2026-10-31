import { randomUUID } from "node:crypto";
import { Problem } from "../shared/problem.js";
import {
  FleetMailCaller,
  FleetMailWorkerRequest,
  FleetMailWorkerResponse,
  FleetMailWorkerState,
} from "../shared/fleet-mail-worker.js";
import type { FleetAgentQuery } from "../shared/fleet-mail-api.js";
import type {
  MailDiscoveryPage,
  MailDiscoverySource,
} from "../shared/fleet-mail-discovery.js";
import type { FleetMailDiscoveryPort } from "./fleet-mail-discovery.js";
import { installFleetMailTools } from "./fleet-mail-tools.js";

const unavailable = () =>
  new Problem(
    503,
    "Remote agent discovery is unavailable in this execution session.",
  );

/** The worker owns tool/run authorization, while the parent owns the peer
 * transport and shared tunnel budget. Lost reads fail; none are replayed. */
export class FleetMailWorkerClient implements FleetMailDiscoveryPort {
  private binding: string | null = null;
  private catalog: MailDiscoverySource[] = [];
  private uninstall?: () => void;
  private stopped = false;
  private readonly pending = new Map<
    string,
    {
      source: string;
      binding: string;
      current(): void;
      resolve(page: MailDiscoveryPage): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private readonly owner: string,
    private readonly generation: string,
    private readonly send: (request: FleetMailWorkerRequest) => void,
    private readonly timeout = 45_000,
  ) {}
  configure(input: unknown) {
    const value = FleetMailWorkerState.parse(input);
    if (this.stopped || value.generation !== this.generation)
      throw unavailable();
    if (value.binding !== this.binding) this.disconnect();
    this.binding = value.binding;
    this.catalog = value.sources;
    if (this.binding && !this.uninstall)
      this.uninstall = installFleetMailTools(this.owner, this);
  }
  sources() {
    return this.catalog.map((source) => ({ ...source }));
  }
  read(
    source: string,
    query: FleetAgentQuery,
    current: () => void,
    caller?: FleetMailCaller,
  ): Promise<MailDiscoveryPage> {
    current();
    if (this.stopped || !this.binding) throw unavailable();
    if (!this.catalog.some((item) => item.sourceId === source && source))
      throw new Problem(
        403,
        "This machine is not authorized for agent discovery.",
      );
    if (this.pending.size >= 16)
      throw new Problem(
        503,
        "Agent discovery is busy. Retry after pending reads finish.",
      );
    const request = FleetMailWorkerRequest.parse({
      requestId: randomUUID(),
      generation: this.generation,
      binding: this.binding,
      sourceId: source,
      query,
      caller,
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(unavailable());
      }, this.timeout);
      timer.unref();
      this.pending.set(request.requestId, {
        source,
        binding: this.binding!,
        current,
        resolve,
        reject,
        timer,
      });
      try {
        current();
        this.send(request);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.requestId);
        reject(error);
      }
    });
  }
  receive(input: unknown) {
    const response = FleetMailWorkerResponse.parse(input);
    if (
      this.stopped ||
      response.generation !== this.generation ||
      response.binding !== this.binding
    )
      return;
    const pending = this.pending.get(response.requestId);
    if (!pending || pending.binding !== response.binding) return;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    try {
      pending.current();
      if (!response.ok)
        throw new Problem(response.error.status, response.error.message);
      if (
        response.page.source.sourceId !== pending.source ||
        response.page.agents.some((agent) => agent.sourceId !== pending.source)
      )
        throw unavailable();
      pending.resolve(response.page);
    } catch (error) {
      pending.reject(error instanceof Error ? error : unavailable());
    }
  }
  private disconnect() {
    this.uninstall?.();
    this.uninstall = undefined;
    this.binding = null;
    this.catalog = [];
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(unavailable());
    }
    this.pending.clear();
  }
  close() {
    this.stopped = true;
    this.disconnect();
  }
}
