export function sortSnippetsByUsage<
  T extends { use_count?: number; last_used_at?: number },
>(items: readonly T[]): T[] {
  if (items.length <= 1) return [...items];
  return items
    .map((item, index) => {
      const count =
        typeof item.use_count === "number" &&
        Number.isFinite(item.use_count) &&
        item.use_count > 0
          ? Math.floor(item.use_count)
          : 0;
      const lastUsedAt =
        typeof item.last_used_at === "number" &&
        Number.isFinite(item.last_used_at) &&
        item.last_used_at > 0
          ? item.last_used_at
          : 0;
      return { item, index, count, lastUsedAt };
    })
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

export function computeKeyboardInset(
  event:
    | {
        endCoordinates?: {
          height?: number;
          screenY?: number;
        };
      }
    | null
    | undefined,
  containerHeight: number,
  platform: string,
): number {
  const height = event?.endCoordinates?.height ?? 0;
  const screenY = event?.endCoordinates?.screenY;
  if (typeof screenY === "number" && Number.isFinite(screenY)) {
    if (screenY >= containerHeight) return 0;
    if (platform === "android" && screenY > 0) {
      return Math.max(0, Math.round(containerHeight - screenY));
    }
  }
  return Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;
}

export function computeQuickSheetLayout({
  windowHeight,
  insetTop,
  insetBottom,
  keyboardInset,
}: {
  windowHeight: number;
  insetTop: number;
  insetBottom: number;
  keyboardInset: number;
}): {
  maxSheetHeight: number;
  maxScrollHeight: number;
  sheetPaddingBottom: number;
} {
  const keyboardVisible = keyboardInset > 0;
  const maxSheetHeight = Math.max(
    0,
    Math.round(windowHeight - insetTop - keyboardInset - 12),
  );
  const sheetPaddingBottom = keyboardVisible
    ? 12
    : Math.max(insetBottom + 14, 22);
  const headerAndChromeHeight = 52 + sheetPaddingBottom;
  const maxScrollHeight = Math.max(0, maxSheetHeight - headerAndChromeHeight);
  return { maxSheetHeight, maxScrollHeight, sheetPaddingBottom };
}
