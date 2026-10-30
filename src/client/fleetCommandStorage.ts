/** IndexedDB transactions provide cross-tab observation ordering. Web Locks
 * alone cannot make another renderer's localStorage cache current. */
async function journal(key: string, value?: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let db: IDBDatabase | undefined, transaction: IDBTransaction | undefined;
    let finished = false;
    const finish = (error?: unknown, result: string | null = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (error && transaction) {
        try {
          transaction.abort();
        } catch {
          /* Already complete. */
        }
      }
      db?.close();
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(
      () => finish(new Error("Command storage timed out")),
      5000,
    );
    let open: IDBOpenDBRequest;
    try {
      open = indexedDB.open("loop-fleet-commands", 1);
    } catch (error) {
      finish(error);
      return;
    }
    open.onupgradeneeded = () => open.result.createObjectStore("journals");
    open.onerror = () =>
      finish(open.error ?? new Error("Command storage failed"));
    open.onblocked = () => finish(new Error("Command storage is blocked"));
    open.onsuccess = () => {
      db = open.result;
      if (finished) {
        db.close();
        return;
      }
      db.onversionchange = () => db?.close();
      try {
        transaction = db.transaction(
          "journals",
          value === undefined ? "readonly" : "readwrite",
          { durability: "strict" },
        );
        const store = transaction.objectStore("journals");
        const request =
          value === undefined ? store.get(key) : store.put(value, key);
        let result: string | null = null;
        request.onsuccess = () => {
          if (value !== undefined) return;
          if (
            request.result !== undefined &&
            typeof request.result !== "string"
          ) {
            finish(new Error("Invalid command storage"));
            return;
          }
          result = request.result ?? null;
        };
        transaction.oncomplete = () => finish(undefined, result);
        transaction.onabort = () =>
          finish(transaction?.error ?? new Error("Command storage aborted"));
        transaction.onerror = () =>
          finish(transaction?.error ?? new Error("Command storage failed"));
      } catch (error) {
        finish(error);
      }
    };
  });
}

export const readFleetJournal = (key: string) => journal(key);
export const writeFleetJournal = async (key: string, value: string) => {
  await journal(key, value);
};
