export function upgradeStorage(storage: Storage) {
  const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i));
  for (const key of keys) {
    if (
      !key ||
      !/^loop[-:]/.test(key) ||
      key.startsWith("loop:fleet-commands:")
    )
      continue;
    const renamed = "loop55" + key.slice(4);
    if (storage.getItem(renamed) === null) {
      const value = storage.getItem(key);
      if (value !== null) storage.setItem(renamed, value);
    }
    storage.removeItem(key);
  }
}

export function upgradeBrowserNames() {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      upgradeStorage(window[name]);
    } catch {
      /* Storage denial must not prevent sign-in. */
    }
  }
  const state = history.state;
  if (state && typeof state === "object") {
    const next = { ...state };
    for (const key of ["loopShellSource", "loopSheet"]) {
      if (key in next) {
        next["loop55" + key.slice(4)] ??= next[key];
        delete next[key];
      }
    }
    history.replaceState(next, "");
  }
}
