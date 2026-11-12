function key(name: string, owner: string) {
  return `${name}:${JSON.stringify(owner)}`;
}

export function recentSearches(owner: string | undefined): string[] {
  if (!owner) return [];
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(key("loop-recent-searches", owner)) || "[]",
    );
    return Array.isArray(value)
      ? value
          .filter((query): query is string => typeof query === "string")
          .slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

export function rememberSearch(owner: string | undefined, query: string) {
  if (!owner) return;
  try {
    localStorage.setItem(
      key("loop-recent-searches", owner),
      JSON.stringify(
        [query, ...recentSearches(owner).filter((q) => q !== query)].slice(
          0,
          8,
        ),
      ),
    );
  } catch {}
}

export function lastVisit(owner: string | undefined): number {
  if (!owner) return 0;
  try {
    const value = Number(
      localStorage.getItem(key("loop-last-visit", owner)) || 0,
    );
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function recordVisit(owner: string | undefined, at: number) {
  if (!owner) return;
  try {
    localStorage.setItem(key("loop-last-visit", owner), String(at));
  } catch {}
}

export function clearRecentSearches(owner: string | undefined) {
  if (!owner) return;
  try {
    localStorage.removeItem(key("loop-recent-searches", owner));
  } catch {}
}

function recipientKey(owner: string, source: string) {
  return `loop-last-recipient:${JSON.stringify([owner, source])}`;
}

export function lastRecipient(
  owner: string | undefined,
  source: string,
): string | null {
  if (!owner) return null;
  try {
    return localStorage.getItem(recipientKey(owner, source));
  } catch {
    return null;
  }
}

export function rememberRecipient(
  owner: string | undefined,
  source: string,
  recipient: string,
) {
  if (!owner) return;
  try {
    localStorage.setItem(recipientKey(owner, source), recipient);
  } catch {
    // Storage restrictions must not turn an accepted send into an error.
  }
}
