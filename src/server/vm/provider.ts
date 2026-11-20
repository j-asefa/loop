// The boundary between Loop and a VM provider. Loop calls a provider only
// after writing a vm_operations receipt (vm/operations.ts); adapters do not
// retry, so an unobserved outcome reaches the caller as VmProviderError with
// outcome "uncertain".

/** `unknown` is a provider status this build does not recognise; callers
 * leave the VM's state alone when they see it. */
export type VmStatus =
  | "provisioning"
  | "running"
  | "sleeping"
  | "paused"
  | "failed"
  | "terminating"
  | "terminated"
  | "unknown";

export type VmLimits = {
  vcpuCount: number;
  memoryLimitGib: number;
  diskLimitGib: number;
};

export type VmVolumeMount = {
  volumeId: string;
  mountPath: string;
  readOnly?: boolean;
};

export interface VmProcessHandle {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  exit: Promise<{ exitCode: number | null; signal: string | null }>;
  kill(): Promise<void>;
}

/** `refused`: the provider answered and did not perform the call.
 * `uncertain`: no answer was observed (timeout, disconnect, 5xx), so the call
 * may have taken effect and must be reconciled before any retry. */
export class VmProviderError extends Error {
  constructor(
    readonly outcome: "refused" | "uncertain",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "VmProviderError";
  }
}

export interface VmProvider {
  readonly kind: "sailbox";
  /** Checks the key and returns the account it belongs to. */
  whoami(): Promise<{ accountId: string }>;
  ensureApp(name: string): Promise<{ appId: string }>;
  ensureVolume(name: string): Promise<{ volumeId: string }>;
  /** Pass a key scoped to the experiment, not to one operation: a retry
   * after a reconcile found no VM then reaches the VM a slow first attempt
   * made instead of creating a second one. The same applies to
   * createFromCheckpoint. */
  create(input: {
    idempotencyKey: string;
    appId: string;
    name: string;
    imageRef: string;
    limits: VmLimits;
    autoSleepSeconds: number;
    volumes: VmVolumeMount[];
  }): Promise<{ remoteId: string; status: VmStatus }>;
  get(remoteId: string): Promise<{ status: VmStatus } | null>;
  /** Live VMs with exactly this name. More than one means Loop cannot tell
   * which to adopt, and the caller must leave the operation uncertain. */
  findByName(
    appId: string,
    name: string,
  ): Promise<{ remoteId: string; status: VmStatus }[]>;
  exec(
    remoteId: string,
    command: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      openStdin?: boolean;
    },
  ): Promise<VmProcessHandle>;
  sleep(remoteId: string, idempotencyKey: string): Promise<void>;
  resume(remoteId: string, idempotencyKey: string): Promise<void>;
  checkpointFilesystem(input: {
    idempotencyKey: string;
    remoteId: string;
    name: string;
    ttlSeconds: number;
  }): Promise<{ checkpointId: string }>;
  /** The new VM keeps the checkpoint's disk, limits and volume mounts;
   * `configure` applies the experiment's own limits and idle window. */
  createFromCheckpoint(input: {
    idempotencyKey: string;
    checkpointId: string;
    name: string;
  }): Promise<{ remoteId: string; status: VmStatus }>;
  /** Sets limits and the idle window. Repeating it with the same values is
   * harmless, so it needs no receipt of its own. */
  configure(
    remoteId: string,
    settings: { limits: VmLimits; autoSleepSeconds: number },
  ): Promise<void>;
  exposeHttpPort(
    remoteId: string,
    port: number,
    idempotencyKey: string,
  ): Promise<{ url: string }>;
  unexposePort(remoteId: string, port: number): Promise<void>;
  /** The published HTTP port, or null when the port is not published. */
  getHttpPort(remoteId: string, port: number): Promise<{ url: string } | null>;
  readFile(remoteId: string, path: string, maxBytes: number): Promise<Buffer>;
  writeFile(remoteId: string, path: string, bytes: Buffer): Promise<void>;
  /** Succeeds when the VM is already gone. */
  terminate(remoteId: string, idempotencyKey: string): Promise<void>;
}
