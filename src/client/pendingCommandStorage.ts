type CommandStorage<T> = {
  read(key: string): T | undefined;
  write(key: string, value: T): void;
  remove(key: string): void;
};

function commandStore<T>(storage: CommandStorage<T>) {
  return (owner: string, source: string, target: readonly string[]) => {
    const key = `loop-effect:${JSON.stringify([owner, source, ...target])}`;
    return {
      key,
      read: () => storage.read(key),
      write: (value: T) => storage.write(key, value),
      remove: () => storage.remove(key),
    };
  };
}

// Callers validate stored records and hold their Web Lock across read/write.
// Storage errors must reach preparation so an unrecorded command cannot run.
export function storedCommands<T>(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
) {
  return commandStore<T>({
    read: (key) => {
      const raw = storage.getItem(key);
      return raw === null ? undefined : (JSON.parse(raw) as T);
    },
    write: (key, value) => storage.setItem(key, JSON.stringify(value)),
    remove: (key) => storage.removeItem(key),
  });
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
