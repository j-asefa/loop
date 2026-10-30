import { readFleetJournal, writeFleetJournal } from "./fleetCommandStorage";
import { z } from "zod";
import { FleetActionInput } from "../shared/fleet-workspace-action-api";
import {
  FleetCommandRoute,
  fleetCommandRoutes,
} from "../shared/fleet-command-api";
import { FleetUploadInput } from "../shared/fleet-workspace-upload-api";
import { workspaceApi } from "../shared/workspace-api";
import { MAX_UPLOAD_BYTES } from "../shared/uploads";
import {
  fleetActionCommandPaths,
  fleetActionInput,
} from "../shared/fleet-action-input";
import {
  canonicalFleetJson,
  fleetOperationBytes,
} from "../shared/fleet-canonical";
import { fleetGatewayApi } from "../shared/fleet-gateway-api";
import { viewGeneration, viewOwner } from "./viewCache";
import type { RouteContract } from "../shared/workspace-api";

const Record = z.strictObject({
  id: z.string().uuid(),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.string().regex(/^peer:m_[a-f0-9]{64}$/),
  payloadDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  route: FleetCommandRoute,
});
const Journal = z.array(Record).max(256);
const Transfer = z.strictObject({
  version: z.literal(1),
  command: Record.extend({ payloadDigest: z.string().regex(/^[a-f0-9]{64}$/) }),
});
export type PendingFleetCommand = z.infer<typeof Record>;
export const fleetCommandsChanged = "loop-fleet-commands";
function changed() {
  // Updating a view must never alter whether an already retained command runs.
  try {
    window.dispatchEvent(new Event(fleetCommandsChanged));
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(fleetCommandsChanged);
      channel.postMessage(null);
      channel.close();
    }
  } catch {
    /* Non-browser callers have no view. */
  }
}
function matches(a: PendingFleetCommand, b: PendingFleetCommand) {
  return (
    a.id === b.id &&
    a.source === b.source &&
    a.route === b.route &&
    a.signature === b.signature &&
    a.payloadDigest === b.payloadDigest
  );
}
const fixedIdentity = "00000000-0000-4000-8000-000000000000";
function commandTurn(
  key: string,
  id: string,
  signal?: AbortSignal,
  ifAvailable = false,
) {
  let begin!: (run: () => Promise<unknown>) => void;
  let acquired!: (held: boolean) => void, refused!: (error: unknown) => void;
  const ready = new Promise<boolean>((resolve, reject) => {
    acquired = resolve;
    refused = reject;
  });
  void ready.catch(() => {});
  const task = new Promise<() => Promise<unknown>>((resolve) => {
    begin = resolve;
  });
  // Reserve FIFO order before publishing the journal entry. Another tab's
  // action or bodyless lookup must wait through authorization and response.
  const pending = navigator.locks.request(
    `${key}:command:${id}`,
    // Web Locks forbids combining a nonblocking request with an abort signal.
    // The caller checks its signal again before publishing a retained entry.
    ifAvailable ? { ifAvailable: true } : { signal },
    async (lock) => {
      acquired(lock !== null);
      if (lock === null) return;
      return (await task)();
    },
  );
  void pending.catch(refused); // Both waiters observe a queued abort.
  return {
    ready,
    run<T>(run: () => Promise<T>): Promise<T> {
      begin(run);
      return pending as Promise<T>;
    },
  };
}
function unavailable(message: string) {
  return Object.assign(new Error(message), {
    status: 503,
    executionOutcome: "unknown" as const,
  });
}
function rebind(input: FleetActionInput | FleetUploadInput, id: string) {
  if (input.route === "uploadCreate") return input;
  const value = structuredClone(input);
  for (const path of fleetActionCommandPaths(value)) {
    const body = value.body as { [key: string]: unknown };
    const target =
      path.length === 1 ? body : (body[path[0]] as { [key: string]: unknown });
    delete target[path.at(-1)!];
  }
  return fleetActionInput(value, id);
}

/** A command is persisted before the first request, under the current origin,
 * owner and source. Web Locks serialize command turns; IndexedDB commits make
 * journal updates visible across browser tabs before those turns advance.
 * Only identities and semantic hashes are retained, never prompts or tokens.
 * Pending entries have no eviction/expiry: inability to retain them refuses IO.
 * Returning to an unresolved intent sends a receipt query, never a new action. */
export async function prepareFleetCommand(
  source: string,
  contract: RouteContract,
  input: { params?: unknown; body?: unknown; file?: Blob; filename?: string },
  signal?: AbortSignal,
) {
  const { current, key, read } = journalScope(signal);
  const route = Object.entries(fleetCommandRoutes).find(
    ([, item]) =>
      item.method === contract.method && item.path === contract.path,
  )?.[0];
  if (!route || !/^peer:m_[a-f0-9]{64}$/.test(source))
    throw Object.assign(
      new Error(
        "This remote operation is unavailable. Open the owning machine's workspace.",
      ),
      { status: 409, executionOutcome: "refused" },
    );
  let upload: FleetUploadInput | undefined;
  if (route === "uploadCreate") {
    if (!input.file || input.file.size > MAX_UPLOAD_BYTES)
      throw Object.assign(new Error("Choose a file up to 25 MB."), {
        status: 413,
        executionOutcome: "refused",
      });
    const bytes = await input.file.arrayBuffer();
    current();
    const checksum = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    current();
    upload = FleetUploadInput.parse({
      route,
      params: {},
      body: {
        options: workspaceApi.uploadCreate.body
          .strict()
          .parse(JSON.parse(JSON.stringify(input.body ?? {}))),
        file: {
          name:
            input.filename ??
            (input.file instanceof File ? input.file.name : "blob"),
          mime: input.file.type || "application/octet-stream",
          size: input.file.size,
          checksum,
        },
      },
    });
  }
  const raw =
    upload ??
    FleetActionInput.parse({
      route,
      params: input.params ?? {},
      // Match JSON transport before hashing: optional form fields often exist
      // with value undefined, which JSON omits from the destination's request.
      body: JSON.parse(JSON.stringify(input.body ?? {})),
    });
  const supplied = (
    raw.route === "uploadCreate" ? [] : fleetActionCommandPaths(raw)
  )
    .map((path) => {
      let value: unknown = raw.body;
      for (const key of path)
        value =
          value && typeof value === "object"
            ? (value as { [key: string]: unknown })[key]
            : undefined;
      return value;
    })
    .find((value) => value !== undefined);
  const proposed =
    supplied === undefined
      ? crypto.randomUUID()
      : z.string().uuid().parse(supplied);
  const normalized =
    raw.route === "uploadCreate" ? raw : fleetActionInput(raw, proposed);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      canonicalFleetJson({ source, input: rebind(normalized, fixedIdentity) }),
    ),
  );
  current();
  const signature = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  async function reserve(preferred: string) {
    const payloadDigest = await operationDigest(rebind(normalized, preferred));
    current();
    const turn: { value?: ReturnType<typeof commandTurn> } = {};
    let inserted: PendingFleetCommand | undefined;
    try {
      let candidate: { id: string; prior: boolean } | undefined;
      while (!candidate) {
        candidate = await navigator.locks.request(key, { signal }, async () => {
          current();
          const entries = await read();
          const sameId = entries.find((entry) => entry.id === preferred);
          if (
            sameId &&
            (sameId.signature !== signature || sameId.source !== source)
          )
            throw new Error("Command identity belongs to a different action");
          const prior = entries.find(
            (entry) => entry.signature === signature && entry.source === source,
          );
          if (prior) {
            turn.value = commandTurn(key, prior.id, signal);
            return { id: prior.id, prior: true };
          }
          if (entries.length >= 256)
            throw new Error("Too many unsettled commands");
          const entry = Record.parse({
            id: preferred,
            signature,
            source,
            route,
            payloadDigest,
          });
          const text = JSON.stringify([...entries, entry]);
          // A busy command lock must be awaited outside the journal lock.
          turn.value = commandTurn(key, preferred, signal, true);
          if (!(await turn.value.ready)) return;
          current();
          inserted = entry;
          await writeFleetJournal(key, text);
          changed();
          return { id: preferred, prior: false };
        });
        if (!candidate)
          await commandTurn(key, preferred, signal).run(async () => {});
      }
      current();
      return { ...candidate, turn: turn.value! };
    } catch {
      if (turn.value)
        await turn.value
          .run(async () => {
            // Preparation can be cancelled while its journal transaction commits.
            // No action fetch has started. Retain the command lock until only this
            // new reservation is removed from the captured owner's journal; older
            // uncertain entries and another owner's journal must remain untouched.
            if (!inserted) return;
            await navigator.locks.request(key, {}, async () => {
              const entries = await read();
              await writeFleetJournal(
                key,
                JSON.stringify(
                  entries.filter((entry) => !matches(entry, inserted!)),
                ),
              );
              changed();
            });
          })
          .catch(() => {
            // Failed cleanup retains uncertainty; it never authorizes replay.
          });
      current();
      throw unavailable(
        "The remote command could not be retained safely. Keep existing receipts and enable browser storage before continuing.",
      );
    }
  }
  let claim = await reserve(proposed);
  let terminal: "completed" | "refused" | undefined;
  let dispatched = false,
    notSent = false;
  return {
    get body() {
      return rebind(normalized, claim.id).body;
    },
    upload,
    current,
    async run<T>(perform: () => Promise<T>): Promise<T> {
      for (;;) {
        const result = await claim.turn.run(async () => {
          // A preceding send may have settled or failed before fetch while we
          // queued. Recheck the captured owner's journal under the command lock;
          // perform rechecks the view before any IO. Never query an absent entry.
          if (
            !(await read()).some(
              (entry) =>
                entry.id === claim.id &&
                entry.signature === signature &&
                entry.source === source,
            )
          )
            return { retry: true as const };
          return { retry: false as const, value: await perform() };
        });
        if (!result.retry) return result.value;
        // Release the command lock before reserving again. Preserve the bound
        // ID even if a previous successful attempt already removed its entry;
        // the gateway's durable journal reconciles any earlier dispatch.
        claim = await reserve(claim.id);
      }
    },
    dispatch() {
      dispatched = true;
    },
    get executionOutcome() {
      return terminal ?? (notSent ? "not_sent" : "unknown");
    },
    get headers() {
      return {
        "x-loop-command-id": claim.id,
        ...(claim.prior ? { "x-loop-receipt-only": "1" } : {}),
      };
    },
    observe(response: Response) {
      if (response.headers.get("x-loop-command-id") !== claim.id) return;
      const state = response.headers.get("x-loop-command-state");
      if (state === "completed" || state === "refused") terminal = state;
    },
    async settle(success: boolean) {
      // This attempt made no action fetch. Keep the caller's explicit identity:
      // local proof is not a destination refusal of any older use of that ID.
      notSent = !success && !claim.prior && !dispatched;
      if (!notSent) current();
      if (success && terminal !== "completed")
        throw unavailable(
          "The owning machine's completion receipt is missing. Check the original command before continuing.",
        );
      if (!terminal && !notSent) return;
      if (!success && terminal === "completed") return;
      try {
        await navigator.locks.request(
          key,
          notSent ? {} : { signal },
          async () => {
            // Even an aborted or superseded view may release its provably unsent
            // entry. The captured owner key and exact identity limit this cleanup;
            // the command lock prevents a later attempt from racing it.
            if (!notSent) current();
            const entries = await read();
            await writeFleetJournal(
              key,
              JSON.stringify(
                entries.filter(
                  (entry) =>
                    entry.id !== claim.id || entry.signature !== signature,
                ),
              ),
            );
            changed();
          },
        );
      } catch {
        // The destination's terminal receipt stays authoritative. Keeping the
        // old browser entry merely makes the next visit query it again.
      }
    },
  };
}

function journalScope(signal?: AbortSignal, requireLock = true) {
  const owner = viewOwner(),
    generation = viewGeneration();
  const current = () => {
    if (!owner || owner !== viewOwner() || generation !== viewGeneration())
      throw unavailable(
        "This workspace session changed. Reopen the owning machine before continuing.",
      );
    signal?.throwIfAborted();
  };
  current();
  if (requireLock && (!navigator.locks || !crypto.subtle))
    throw unavailable(
      "This browser cannot safely retain remote commands. Use an updated browser over HTTPS.",
    );
  const key = `loop:fleet-commands:v1:${encodeURIComponent(owner!)}`;
  const read = async () => {
    // Retain older browser receipts on first use; committed IndexedDB state,
    // including an empty journal, always supersedes this legacy fallback.
    const raw = (await readFleetJournal(key)) ?? localStorage.getItem(key);
    if (raw && raw.length > 160_000)
      throw new Error("Oversized command journal");
    return Journal.parse(JSON.parse(raw ?? "[]"));
  };
  return { current, key, read };
}
async function operationDigest(input: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    fleetOperationBytes(input),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function pendingFleetCommands(
  signal?: AbortSignal,
): Promise<PendingFleetCommand[]> {
  const { read, current } = journalScope(signal, false);
  try {
    const entries = await read();
    current();
    return entries;
  } catch {
    throw unavailable(
      "Existing command receipts cannot be read. Keep this browser's storage and open the owning machine to inspect its work.",
    );
  }
}

/** Explicitly move only a receipt reference across origins. It grants no access
 * and contains no original prompt, answer, owner ID or reusable credential. */
export async function exportFleetCommand(
  input: PendingFleetCommand,
  signal?: AbortSignal,
) {
  const { read, current } = journalScope(signal, false);
  const command = Transfer.shape.command.parse(input);
  if (!(await read()).some((entry) => matches(entry, command)))
    throw unavailable("This receipt is no longer pending in this workspace.");
  current();
  return JSON.stringify({ version: 1, command });
}

export async function importFleetCommand(text: string, signal?: AbortSignal) {
  const { key, read, current } = journalScope(signal);
  let command: z.infer<typeof Transfer>["command"];
  try {
    if (text.length > 2048) throw new Error("Oversized receipt");
    command = Transfer.parse(JSON.parse(text)).command;
  } catch {
    throw new Error(
      "Paste an unchanged receipt copied from Loop's Actions to check.",
    );
  }
  await navigator.locks.request(key, { signal }, async () => {
    current();
    const entries = await read();
    if (entries.some((entry) => matches(entry, command))) return;
    if (
      entries.some(
        (entry) =>
          entry.id === command.id ||
          (entry.source === command.source &&
            entry.signature === command.signature),
      )
    )
      throw new Error(
        "A different receipt already identifies this action. Keep the original receipt.",
      );
    if (entries.length >= 256)
      throw new Error("Check existing actions before adding more receipts.");
    const value = JSON.stringify([...entries, command]);
    current();
    await writeFleetJournal(key, value);
    changed();
  });
  current();
  return command;
}

/** An explicit check can run after reload without retaining or reconstructing
 * the original prompt. Unknown and missing receipts always remain pending. */
export async function reconcileFleetCommand(
  input: PendingFleetCommand,
  signal?: AbortSignal,
) {
  const command = Record.parse(input);
  const { key, current, read } = journalScope(signal);
  const isCommand = (entry: PendingFleetCommand) => matches(entry, command);
  if (!(await read()).some(isCommand))
    throw unavailable(
      "This command belongs to another workspace session. Reopen its original receipt.",
    );
  const payloadDigest = command.payloadDigest;
  if (!payloadDigest)
    throw unavailable(
      "This older receipt requires the original action to check its outcome. Keep its command ID and inspect the owning machine.",
    );
  return commandTurn(key, command.id, signal).run(async () => {
    const { callRoute } = await import("./api");
    current();
    if (!(await read()).some(isCommand))
      throw unavailable(
        "This receipt is no longer pending in this browser. Refresh the action's current state before continuing.",
      );
    const receipt = await callRoute(
      fleetGatewayApi.receipt,
      {
        body: {
          peer: command.source.slice(5),
          commandId: command.id,
          route: command.route,
          payloadDigest,
        },
      },
      "",
      signal,
    );
    current();
    if (receipt.commandId !== command.id)
      throw unavailable(
        "The returned receipt has a different command identity. Keep the original receipt.",
      );
    const result =
      receipt.result === null
        ? null
        : fleetCommandRoutes[command.route].response.parse(receipt.result);
    if (["completed", "refused"].includes(receipt.state)) {
      try {
        await navigator.locks.request(key, { signal }, async () => {
          current();
          await writeFleetJournal(
            key,
            JSON.stringify((await read()).filter((entry) => !isCommand(entry))),
          );
          changed();
        });
      } catch {
        // A retained entry is safe: future checks still only query its receipt.
      }
    }
    current();
    return { ...receipt, result };
  });
}
