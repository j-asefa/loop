type Entry = { close: () => void };

// One history entry represents the open sheet stack. Replacing a sheet must
// not add another Back step, and Back dismisses only the topmost sheet.
const sheets: Entry[] = [];
let ownsEntry = false;
let pendingBack: string | null = null;
let scheduled = false;

function reconcile() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    if (pendingBack !== null) return;
    if (sheets.length && !ownsEntry) {
      history.pushState(
        { ...history.state, loopSheet: true },
        "",
        location.href,
      );
      ownsEntry = true;
    } else if (!sheets.length && ownsEntry) {
      ownsEntry = false;
      pendingBack = location.href;
      history.back();
    }
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    if (pendingBack !== null) {
      // The owning view may have cleared its conversation URL while closing.
      const url = pendingBack;
      pendingBack = null;
      history.replaceState(history.state, "", url);
    } else {
      ownsEntry = false;
      sheets.at(-1)?.close();
    }
    reconcile();
  });
}

export function registerSheet(close: () => void) {
  const entry = { close };
  sheets.push(entry);
  reconcile();
  return () => {
    const index = sheets.indexOf(entry);
    if (index !== -1) sheets.splice(index, 1);
    reconcile();
  };
}
