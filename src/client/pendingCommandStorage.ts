type CommandStorage<T> = {
  read(key: string): T | undefined;
  write(key: string, value: T): void;
  remove(key: string): void;
};

export type BrowserCommandStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export function commandStorageKey(
  owner: string | undefined,
  source: string,
  target: readonly (string | null)[],
  namespace = "loop-effect",
) {
  return `${namespace}:${JSON.stringify([owner, source, ...target])}`;
}

function commandSlot<T>(storage: CommandStorage<T>, key: string) {
  return {
    key,
    read: () => storage.read(key),
    write: (value: T) => storage.write(key, value),
    remove: () => storage.remove(key),
  };
}

function commandStore<T>(storage: CommandStorage<T>) {
  return (owner: string, source: string, target: readonly string[]) =>
    commandSlot(storage, commandStorageKey(owner, source, target));
}

function jsonStorage<T>(
  storage: BrowserCommandStorage,
  decode: (raw: string) => T = JSON.parse,
): CommandStorage<T> {
  return {
    read: (key) => {
      const raw = storage.getItem(key);
      return raw === null ? undefined : decode(raw);
    },
    write: (key, value) => storage.setItem(key, JSON.stringify(value)),
    remove: (key) => storage.removeItem(key),
  };
}

// Callers validate stored records and hold their Web Lock across read/write.
// Storage errors must reach preparation so an unrecorded command cannot run.
export function storedCommands<T>(storage: BrowserCommandStorage) {
  return commandStore(jsonStorage<T>(storage));
}

export function storedCommandAt<T>(
  storage: BrowserCommandStorage,
  key: string,
  decode?: (raw: string) => T,
) {
  return commandSlot(jsonStorage<T>(storage, decode), key);
}

export function withCommandLock<T>(
  key: string,
  action: () => T,
  unavailable = "Cannot protect pending changes; nothing was sent.",
): Promise<T> {
  if (!globalThis.navigator?.locks)
    return Promise.reject(new Error(unavailable));
  return navigator.locks.request(key, action);
}

// Token creation receipts contain secrets. Their adapter must never acquire a
// persistent backend, even though they share command scoping with durable work.
export function memoryCommands<T>() {
  const records = new Map<string, T>();
  return commandStore<T>({
    read: (key) => records.get(key),
    write: (key, value) => {
      records.set(key, value);
    },
    remove: (key) => {
      records.delete(key);
    },
  });
}
