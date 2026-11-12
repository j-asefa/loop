import { workspaceApi, type RouteInput } from "../shared/workspace-api";
import { withOptionalStorage } from "./browserStorage";
import { commandStorageKey, storedCommandAt } from "./pendingCommandStorage";

type ContinuationInput = RouteInput<
  typeof workspaceApi.conversationContinueStart
>["body"];

export function continuationStorageKey(
  owner: string | undefined,
  source: string,
  thread: string,
) {
  return commandStorageKey(owner, source, [thread], "loop-continuation");
}

function storedContinuationAt(
  storage: Storage,
  key: string,
): ContinuationInput | null {
  try {
    const parsed = workspaceApi.conversationContinueStart.body.safeParse(
      storedCommandAt<unknown>(storage, key).read(),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function storedContinuations(key: string): ContinuationInput[] {
  return withOptionalStorage(
    "local",
    (storage) => {
      const requests = new Map<string, ContinuationInput>();
      for (const slot of Object.keys(storage)
        .filter((k) => k.startsWith(key + ":"))
        .sort()) {
        const request = storedContinuationAt(storage, slot);
        if (request) requests.set(request.start.idempotencyKey, request);
      }
      return [...requests.values()];
    },
    [],
  );
}

export function storedContinuation(key: string): ContinuationInput | null {
  // Keep each tab's choice, while allowing a new tab to recover saved requests.
  const preferred = withOptionalStorage(
    "session",
    (storage) => storage.getItem(key),
    null,
  );
  if (preferred === "new") return null;
  const requests = storedContinuations(key);
  return (
    requests.find((request) => request.start.idempotencyKey === preferred) ||
    requests[0] ||
    null
  );
}

export function selectContinuation(key: string, identity: string) {
  withOptionalStorage(
    "session",
    (storage) => storage.setItem(key, identity),
    undefined,
  );
}

export function storeContinuation(key: string, request: ContinuationInput) {
  // The durable request must be saved before dispatch; a per-tab selection is
  // optional and cannot replace it as the recovery identity.
  storedCommandAt<ContinuationInput>(
    localStorage,
    key + ":" + request.start.idempotencyKey,
  ).write(request);
  selectContinuation(key, request.start.idempotencyKey);
}

export function clearStoredContinuation(
  key: string,
  request: ContinuationInput,
) {
  // An accepted response must still open its conversation if device storage
  // refuses cleanup. Any retained request can safely recover that same receipt.
  withOptionalStorage(
    "local",
    (storage) => {
      storedCommandAt(
        storage,
        key + ":" + request.start.idempotencyKey,
      ).remove();
    },
    undefined,
  );
  withOptionalStorage(
    "session",
    (storage) => {
      if (storage.getItem(key) === request.start.idempotencyKey)
        storage.removeItem(key);
    },
    undefined,
  );
}
