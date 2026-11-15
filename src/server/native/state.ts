import { NativeSessionCurrency } from "./currency.js";
import type { Item } from "../../shared/protocol.js";
import { NativeOutput } from "../native-output.js";

import { type Run } from "../queue.js";
import { type Adapter } from "../../adapters/types.js";
import { type Harness, type Request } from "../../shared/protocol.js";
import { type PermissionMode } from "../../shared/permission-modes.js";

export type Binding = {
  conversation_id: string;
  harness: Harness;
  native_id: string | null;
  project: string;
  // A bound agent with no worktree source uses its ordinary project directory.
  // The agent identity pins both workspace modes.
  worktree_source: string | null;
  worktree_agent_id: string;
  model: string | null;
  effort?: string | null;
  permission_mode?: string | null;
  permission_base?: string | null;
  instructions: string;
  generation: string;
  state: string;
};

/** Mutable storage is private to the session owner. */
type MutableLive = {
  adapter: Adapter;
  generation: string;
  binding: Binding;
  ready: Promise<void>;
  bootstrapRun: Run;
  run?: Run;
  /** The model the harness last reported for this session. */
  reportedModel?: string;
  items: NativeOutput;
  requests: Map<string, Request>;
  finish?: (state: string) => void;
  flush?: NodeJS.Timeout;
  idle?: NodeJS.Timeout;
  closed: boolean;
  /** Replacement must wait until the previous native process has exited. */
  disposal?: Promise<void>;
  cancelling: boolean;
  waiting: boolean;
  bridgeWaiting: number;
  /** The workspace approval level for this session's current turn. */
  permissionMode?: PermissionMode;
  /**
   * The native permission mode chosen for this session in Session settings.
   * It outranks the workspace level for Loop's automatic answers.
   */
  sessionMode?: string;
};

/** Readers retain identity but cannot write session fields or collections. */
export type Live = Readonly<
  Omit<MutableLive, "binding" | "items" | "requests">
> & {
  readonly binding: Readonly<Binding>;
  readonly items: Pick<NativeOutput, "get" | "values" | "bytes"> & {
    readonly dirty: ReadonlySet<string>;
  };
  readonly requests: ReadonlyMap<string, Request>;
};
export type SessionSeed = Pick<
  MutableLive,
  "binding" | "generation" | "bootstrapRun"
> &
  Partial<
    Pick<
      MutableLive,
      "run" | "permissionMode" | "sessionMode" | "finish" | "ready"
    >
  > & {
    adapter: Adapter | ((live: Live) => Adapter);
  };

/** Owns retained session identity, lifecycle fields and display/decision buffers. */
export class NativeSessionState {
  private readonly sessions = new Map<string, Live>();
  readonly currency = new NativeSessionCurrency({
    get: (conversation) => this.find(conversation),
  });
  get size() {
    return this.sessions.size;
  }
  find(conversation: string) {
    return this.sessions.get(conversation);
  }
  all() {
    return this.sessions.values();
  }
  attach(seed: SessionSeed): Live {
    const live: MutableLive = {
      ...seed,
      adapter: undefined as unknown as Adapter,
      ready: seed.ready ?? Promise.resolve(),
      items: new NativeOutput(),
      requests: new Map(),
      closed: false,
      cancelling: false,
      waiting: false,
      bridgeWaiting: 0,
    };
    live.adapter =
      typeof seed.adapter === "function" ? seed.adapter(live) : seed.adapter;
    this.sessions.set(live.binding.conversation_id, live);
    return live;
  }
  remove(live: Live) {
    if (this.currency.allows({ kind: "dispose-entry", live }))
      this.sessions.delete(live.binding.conversation_id);
  }
  ready(live: Live, ready: Promise<void>) {
    this.mutable(live).ready = ready;
  }
  private mutable(live: Live) {
    return live as MutableLive;
  }
  nativeId(live: Live, value: string) {
    this.mutable(live).binding.native_id = value;
  }
  reportedModel(live: Live, value: string | undefined) {
    this.mutable(live).reportedModel = value;
  }
  sessionMode(live: Live, value: string | undefined) {
    this.mutable(live).sessionMode = value;
  }
  permissionBinding(live: Live, mode: string, base: string) {
    const binding = this.mutable(live).binding;
    binding.permission_mode = mode;
    binding.permission_base = base;
  }
  reuse(live: Live, permissionMode: PermissionMode) {
    clearTimeout(live.idle);
    this.mutable(live).permissionMode = permissionMode;
  }
  startTurn(live: Live, run: Run) {
    const state = this.mutable(live);
    state.items.clear();
    state.requests.clear();
    clearTimeout(state.idle);
    state.run = run;
    state.cancelling = false;
  }
  detachTurn(live: Live) {
    this.mutable(live).run = undefined;
  }
  endTurn(live: Live) {
    const state = this.mutable(live);
    state.run = undefined;
    state.finish = undefined;
    state.waiting = false;
    state.cancelling = false;
  }
  onFinish(live: Live, finish: (state: string) => void) {
    this.mutable(live).finish = finish;
  }
  completion(live: Live) {
    return new Promise<string>((resolve) => this.onFinish(live, resolve));
  }
  request(live: Live, request: Request) {
    this.mutable(live).requests.set(request.id, request);
  }
  waiting(live: Live, waiting: boolean) {
    this.mutable(live).waiting = waiting;
  }
  resolveRequest(live: Live, id: string) {
    this.mutable(live).requests.delete(id);
  }
  clearRequests(live: Live) {
    this.mutable(live).requests.clear();
    this.mutable(live).waiting = false;
  }
  recordItem(live: Live, item: Item) {
    return this.mutable(live).items.set(item.id, item);
  }
  replayItem(live: Live, item: Item) {
    return this.mutable(live).items.replay(item);
  }
  clearOutput(live: Live) {
    this.mutable(live).items.clear();
  }
  outputCommitted(live: Live) {
    this.mutable(live).items.dirty.clear();
  }
  scheduleOutput(live: Live, flush: () => void) {
    this.mutable(live).flush = setTimeout(() => {
      this.mutable(live).flush = undefined;
      flush();
    }, 1000);
  }
  clearFlush(live: Live) {
    clearTimeout(live.flush);
    this.mutable(live).flush = undefined;
  }
  clearIdle(live: Live | undefined) {
    clearTimeout(live?.idle);
  }
  scheduleIdle(live: Live, eligible: boolean, dispose: () => void) {
    clearTimeout(live.idle);
    if (eligible) this.mutable(live).idle = setTimeout(dispose, 60_000);
  }
  cancel(live: Live) {
    this.mutable(live).cancelling = true;
  }
  close(live: Live) {
    this.mutable(live).closed = true;
    clearTimeout(live.flush);
    clearTimeout(live.idle);
  }
  disposing(live: Live, disposal: Promise<void>) {
    this.mutable(live).disposal = disposal;
    return disposal;
  }
  bridgeWait(live: Live, waiting: boolean) {
    this.mutable(live).bridgeWaiting += waiting ? 1 : -1;
  }
}
