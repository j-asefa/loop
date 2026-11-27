import { createContext, useContext, useMemo, useRef } from "react";

/**
 * A sideways-scrolling block (table, code) inside a sideways pager such as
 * the Done carousel loses its swipe to the pager. The pager provides this
 * setter; the block holds the pager still while it is being touched.
 */
export const PagerLock = createContext<((locked: boolean) => void) | null>(
  null,
);

/** Props for a horizontal ScrollView that should win over its pager. */
export function usePagerLockProps() {
  const lock = useContext(PagerLock);
  const dragging = useRef(false);
  return useMemo(() => {
    if (!lock) return {};
    const release = () => {
      dragging.current = false;
      lock(false);
    };
    return {
      onTouchStart: () => lock(true),
      onTouchEnd: release,
      // iOS cancels the touch once the native scroll takes over; keep the
      // pager held until that drag ends.
      onTouchCancel: () => {
        if (!dragging.current) lock(false);
      },
      onScrollBeginDrag: () => {
        dragging.current = true;
      },
      onScrollEndDrag: release,
      onMomentumScrollEnd: release,
    };
  }, [lock]);
}
