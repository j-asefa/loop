import { withOptionalStorage } from "./browserStorage";

function key(name: string, owner: string) {
  return `${name}:${JSON.stringify(owner)}`;
}

export function recentSearches(owner: string | undefined): string[] {
  if (!owner) return [];
  return withOptionalStorage(
    "local",
    (storage) => {
      const value: unknown = JSON.parse(
        storage.getItem(key("loop-recent-searches", owner)) || "[]",
      );
      return Array.isArray(value)
        ? value
            .filter((query): query is string => typeof query === "string")
            .slice(0, 8)
        : [];
    },
    [],
  );
}

export function rememberSearch(owner: string | undefined, query: string) {
  if (!owner) return;
  return withOptionalStorage(
    "local",
    (storage) => {
      storage.setItem(
        key("loop-recent-searches", owner),
        JSON.stringify(
          [query, ...recentSearches(owner).filter((q) => q !== query)].slice(
            0,
            8,
          ),
        ),
      );
    },
    undefined,
  );
}

export function lastVisit(owner: string | undefined): number {
  if (!owner) return 0;
  return withOptionalStorage(
    "local",
    (storage) => {
      const value = Number(storage.getItem(key("loop-last-visit", owner)) || 0);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    },
    0,
  );
}

export function recordVisit(owner: string | undefined, at: number) {
  if (!owner) return;
  return withOptionalStorage(
    "local",
    (storage) => {
      storage.setItem(key("loop-last-visit", owner), String(at));
    },
    undefined,
  );
}

export function clearRecentSearches(owner: string | undefined) {
  if (!owner) return;
  return withOptionalStorage(
    "local",
    (storage) => {
      storage.removeItem(key("loop-recent-searches", owner));
    },
    undefined,
  );
}

function recipientKey(owner: string, source: string) {
  return `loop-last-recipient:${JSON.stringify([owner, source])}`;
}

export function lastRecipient(
  owner: string | undefined,
  source: string,
): string | null {
  if (!owner) return null;
  return withOptionalStorage(
    "local",
    (storage) => {
      return storage.getItem(recipientKey(owner, source));
    },
    null,
  );
}

export function rememberRecipient(
  owner: string | undefined,
  source: string,
  recipient: string,
) {
  if (!owner) return;
  return withOptionalStorage(
    "local",
    (storage) => {
      storage.setItem(recipientKey(owner, source), recipient);
    },
    undefined,
  );
}
