import { PassThrough, Writable } from "node:stream";
import {
  VmProviderError,
  type VmLimits,
  type VmProcessHandle,
  type VmProvider,
  type VmStatus,
} from "./provider.js";

// Sailboxes over their HTTPS API (https://docs.sailresearch.com/sailboxes-http-api).
// Loop does not bundle @sailresearch/sdk, which ships native binaries.
// Nothing here retries: each method makes one request and reports what was
// observed, so vm/operations.ts can keep an unanswered call uncertain.

export const SAILBOX_API = "https://sailbox-api.sailresearch.com/v1";
export const SAIL_APPS_API = "https://api.sailresearch.com/v1";

/** Base image the golden experiment image is installed on: Debian with
 * systemd and Docker already running (see vm/sailbox-image.ts). */
export const SAILBOX_BASE_IMAGE = "BASE_IMAGE_DEVBOX";

const CONTROL_TIMEOUT_MS = 60_000;
// Create and start-from-checkpoint wait for the VM to boot.
const BOOT_TIMEOUT_MS = 10 * 60_000;
const MAX_LIST_PAGES = 20;

type Fetch = typeof fetch;

const statuses: Record<string, VmStatus> = {
  creating: "provisioning",
  running: "running",
  sleeping: "sleeping",
  paused: "paused",
  interrupted_restorable: "paused",
  terminating: "terminating",
  terminated: "terminated",
  failed: "failed",
  create_failed: "failed",
  interrupted_unsafe_to_retry: "failed",
};
/** Sail documents its status list as open, so a new value is `unknown`. */
export function sailboxStatus(status: unknown): VmStatus {
  return (typeof status === "string" && statuses[status]) || "unknown";
}

function message(body: unknown, fallback: string) {
  const error =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: { message?: unknown } }).error
      : undefined;
  return typeof error?.message === "string" ? error.message : fallback;
}

// A 4xx answer, including 429 (Sail documents that the request never ran),
// means nothing happened. 501 is a definite refusal too. Any other 5xx, a
// timeout or a dropped connection may follow a change Sail already made.
function refusedStatus(status: number) {
  return (status >= 400 && status < 500) || status === 501;
}

export function createSailboxProvider(options: {
  apiKey: string;
  fetch?: Fetch;
  apiBase?: string;
  appsBase?: string;
}): VmProvider {
  const send = options.fetch ?? fetch;
  const api = options.apiBase ?? SAILBOX_API;
  const apps = options.appsBase ?? SAIL_APPS_API;

  async function request(
    method: string,
    url: string,
    init: {
      body?: unknown;
      raw?: Buffer;
      idempotencyKey?: string;
      timeoutMs?: number;
      accept404?: boolean;
    } = {},
  ): Promise<Response | null> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.apiKey}`,
    };
    if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
    let body: BodyInit | undefined;
    if (init.raw !== undefined) {
      headers["content-type"] = "application/octet-stream";
      body = new Uint8Array(init.raw);
    } else if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    let response: Response;
    try {
      response = await send(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(init.timeoutMs ?? CONTROL_TIMEOUT_MS),
      });
    } catch (error) {
      throw new VmProviderError(
        "uncertain",
        `Sailboxes ${method} did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.ok) return response;
    if (response.status === 404 && init.accept404) return null;
    const text = await response.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    throw new VmProviderError(
      refusedStatus(response.status) ? "refused" : "uncertain",
      message(parsed, `Sailboxes answered ${response.status}`),
      response.status,
    );
  }

  async function json(
    method: string,
    url: string,
    init?: Parameters<typeof request>[2],
  ): Promise<Record<string, unknown>> {
    const response = await request(method, url, init);
    if (!response) return {};
    try {
      const value: unknown = await response.json();
      if (value && typeof value === "object")
        return value as Record<string, unknown>;
    } catch {
      // fall through: an answer Loop cannot read is not an observed outcome
    }
    throw new VmProviderError(
      "uncertain",
      `Sailboxes ${method} answered with a body Loop could not read`,
    );
  }

  const box = (remoteId: string) =>
    `${api}/sailboxes/${encodeURIComponent(remoteId)}`;

  function field(value: Record<string, unknown>, name: string) {
    const item = value[name];
    if (typeof item !== "string" || item.length === 0)
      throw new VmProviderError(
        "uncertain",
        `Sailboxes answered without ${name}`,
      );
    return item;
  }

  // A create that answers 200 with status "failed" did not leave a VM that
  // can run; Sail reports the reason in error_message.
  function created(value: Record<string, unknown>) {
    const remoteId = field(value, "sailbox_id");
    return { remoteId, status: sailboxStatus(value.status) };
  }

  return {
    kind: "sailbox",

    async whoami() {
      const value = await json("GET", `${api}/whoami`);
      return { accountId: field(value, "org_id") };
    },

    async ensureApp(name) {
      const value = await json("POST", `${apps}/apps/find`, {
        body: { name, mint_if_missing: true },
      });
      return { appId: field(value, "id") };
    },

    async ensureVolume(name) {
      // Creating a volume that already exists returns it.
      const value = await json("POST", `${api}/sailbox-volumes`, {
        body: { name },
        idempotencyKey: `loop-volume-${name}`,
      });
      return { volumeId: field(value, "volume_id") };
    },

    async create(input) {
      return created(
        await json("POST", `${api}/sailboxes`, {
          idempotencyKey: input.idempotencyKey,
          timeoutMs: BOOT_TIMEOUT_MS,
          body: {
            app_id: input.appId,
            name: input.name,
            image: { base: input.imageRef },
            visibility: "private",
            vcpu_count: input.limits.vcpuCount,
            memory_limit_gib: input.limits.memoryLimitGib,
            state_disk_limit_gib: input.limits.diskLimitGib,
            auto_sleep: {
              automatic: true,
              min_seconds_before_sleep: input.autoSleepSeconds,
            },
            volume_mounts: input.volumes.map((volume) => ({
              volume_id: volume.volumeId,
              mount_path: volume.mountPath,
              read_only: volume.readOnly ?? false,
            })),
          },
        }),
      );
    },

    async get(remoteId) {
      const response = await request("GET", box(remoteId), {
        accept404: true,
      });
      if (!response) return null;
      const value = (await response.json()) as Record<string, unknown>;
      return { status: sailboxStatus(value.status) };
    },

    async findByName(appId, name) {
      const matches: { remoteId: string; status: VmStatus }[] = [];
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const query = new URLSearchParams({
          app: appId,
          name,
          exclude_status: "terminated",
          limit: "100",
          offset: String(page * 100),
        });
        const value = await json("GET", `${api}/sailboxes?${query}`);
        const data = Array.isArray(value.data) ? value.data : [];
        for (const item of data as Record<string, unknown>[])
          if (item.name === name)
            matches.push({
              remoteId: field(item, "sailbox_id"),
              status: sailboxStatus(item.status),
            });
        if (value.has_more !== true) return matches;
      }
      // An incomplete list cannot prove a VM is absent.
      throw new VmProviderError(
        "uncertain",
        "Sailboxes listed more pages than Loop reads",
      );
    },

    exec(remoteId, command, execOptions) {
      return startExec(request, box(remoteId), command, execOptions);
    },

    async sleep(remoteId, idempotencyKey) {
      await request("POST", `${box(remoteId)}/sleep`, {
        body: {},
        idempotencyKey,
      });
    },

    async resume(remoteId, idempotencyKey) {
      const value = await json("POST", `${box(remoteId)}/resume`, {
        body: {},
        idempotencyKey,
        timeoutMs: BOOT_TIMEOUT_MS,
      });
      if (value.resume_state === "terminal_unavailable")
        throw new VmProviderError(
          "refused",
          message(value, "The Sailbox can no longer be resumed"),
        );
    },

    async checkpointFilesystem(input) {
      const value = await json("POST", `${box(input.remoteId)}/checkpoint`, {
        idempotencyKey: input.idempotencyKey,
        timeoutMs: BOOT_TIMEOUT_MS,
        body: {
          include_memory: false,
          name: input.name,
          ttl_seconds: input.ttlSeconds,
        },
      });
      return { checkpointId: field(value, "checkpoint_id") };
    },

    async createFromCheckpoint(input) {
      return created(
        await json("POST", `${api}/sailboxes/from_checkpoint`, {
          idempotencyKey: input.idempotencyKey,
          timeoutMs: BOOT_TIMEOUT_MS,
          body: { checkpoint_id: input.checkpointId, name: input.name },
        }),
      );
    },

    async configure(
      remoteId,
      settings: { limits: VmLimits; autoSleepSeconds: number },
    ) {
      await request("POST", `${box(remoteId)}/set-limits`, {
        body: {
          vcpu_count: settings.limits.vcpuCount,
          memory_limit_gib: settings.limits.memoryLimitGib,
          state_disk_limit_gib: settings.limits.diskLimitGib,
        },
      });
      await request("POST", `${box(remoteId)}/auto_sleep`, {
        body: {
          automatic: true,
          min_seconds_before_sleep: settings.autoSleepSeconds,
        },
      });
    },

    async exposeHttpPort(remoteId, port, idempotencyKey) {
      const value = await json("POST", `${box(remoteId)}/listeners`, {
        idempotencyKey,
        body: { guest_port: port, protocol: "http" },
      });
      return { url: field(value, "public_url") };
    },

    async unexposePort(remoteId, port) {
      await request("DELETE", `${box(remoteId)}/listeners/${port}`, {
        accept404: true,
      });
    },

    async readFile(remoteId, path, maxBytes) {
      const response = await request(
        "GET",
        `${box(remoteId)}/files?${new URLSearchParams({ path })}`,
      );
      if (!response?.body)
        throw new VmProviderError("refused", `No file at ${path}`);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body.cancel();
        throw new VmProviderError(
          "refused",
          `${path} is larger than ${maxBytes} bytes`,
        );
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > maxBytes)
          throw new VmProviderError(
            "refused",
            `${path} is larger than ${maxBytes} bytes`,
          );
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },

    async writeFile(remoteId, path, bytes) {
      await request(
        "PUT",
        `${box(remoteId)}/files?${new URLSearchParams({ path, mode: "420" })}`,
        { raw: bytes },
      );
    },

    async terminate(remoteId, idempotencyKey) {
      // Terminating a Sailbox that is already gone succeeds.
      await request("POST", `${box(remoteId)}/terminate`, {
        body: {},
        idempotencyKey,
        accept404: true,
      });
    },
  };
}

// Sail applies `cwd` only to string commands. Loop passes argument arrays so
// nothing is shell-parsed, so the working directory is set by a fixed script
// that receives the directory and the command as separate arguments.
export function sailboxArgv(command: string[], cwd: string | undefined) {
  if (cwd === undefined) return command;
  return [
    "/bin/sh",
    "-c",
    'cd -- "$1" || exit 127; shift; exec "$@"',
    "loop-exec",
    cwd,
    ...command,
  ];
}

type Request = (
  method: string,
  url: string,
  init?: {
    body?: unknown;
    raw?: Buffer;
    timeoutMs?: number;
  },
) => Promise<Response | null>;

/** Starts a command and returns its streams. stdout and stderr come from the
 * NDJSON event stream; stdin writes are PUTs at absolute offsets. A dropped
 * event stream ends both outputs and resolves `exit` with no code. */
async function startExec(
  request: Request,
  boxUrl: string,
  command: string[],
  options: { cwd?: string; env?: Record<string, string>; openStdin?: boolean },
): Promise<VmProcessHandle> {
  const response = await request("POST", `${boxUrl}/exec`, {
    timeoutMs: 24 * 60 * 60_000,
    body: {
      command: sailboxArgv(command, options.cwd),
      env: options.env ?? {},
      open_stdin: options.openStdin ?? false,
      close_stdin_on_disconnect: true,
    },
  });
  if (!response?.body)
    throw new VmProviderError("uncertain", "Sailboxes exec sent no stream");
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let execId: string | undefined;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  const body = response.body;

  const exit = (async () => {
    let result: { exitCode: number | null; signal: string | null } = {
      exitCode: null,
      signal: null,
    };
    let buffered = "";
    const decoder = new TextDecoder();
    const handle = (line: string) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (
        event.type === "started" &&
        typeof event.exec_request_id === "string"
      ) {
        execId = event.exec_request_id;
        started();
      } else if (
        (event.type === "stdout" || event.type === "stderr") &&
        typeof event.data === "string"
      )
        (event.type === "stdout" ? stdout : stderr).write(
          Buffer.from(event.data, "base64"),
        );
      else if (event.type === "exit")
        result = {
          exitCode:
            typeof event.return_code === "number" ? event.return_code : null,
          signal: typeof event.signal === "string" ? event.signal : null,
        };
    };
    try {
      for await (const chunk of body) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          handle(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
        }
      }
      handle(buffered);
    } catch {
      // The stream dropped; the command's outcome is unknown.
    } finally {
      started();
      stdout.end();
      stderr.end();
    }
    return result;
  })();

  let offset = 0;
  const putStdin = async (bytes: Buffer, eof: boolean) => {
    await ready;
    if (!execId) throw new Error("The command ended before it started");
    const query = new URLSearchParams({
      offset: String(offset),
      ...(eof ? { eof: "true" } : {}),
    });
    await request(
      "PUT",
      `${boxUrl}/exec/-/stdin?exec_request_id=${encodeURIComponent(execId)}&${query}`,
      { raw: bytes },
    );
    offset += bytes.byteLength;
  };
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      putStdin(Buffer.from(chunk), false).then(() => callback(), callback);
    },
    final(callback) {
      if (!options.openStdin) return callback();
      putStdin(Buffer.alloc(0), true).then(() => callback(), callback);
    },
  });

  return {
    stdin,
    stdout,
    stderr,
    exit,
    async kill() {
      await ready;
      if (!execId) return;
      await request(
        "POST",
        `${boxUrl}/exec/-/cancel?exec_request_id=${encodeURIComponent(execId)}`,
        { body: { force: true } },
      );
    },
  };
}
