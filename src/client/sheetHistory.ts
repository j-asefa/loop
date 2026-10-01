type Entry = { close: () => void };

// One history entry represents the open sheet stack. Replacing a sheet must
// not add another Back step, and Back dismisses only the topmost sheet.
const sheets: Entry[] = [];
let ownsEntry = false;
let pendingBack: string | null = null;
let backWatchdog: ReturnType<typeof setTimeout> | undefined;

// Leave the sheet's history entry. WebKit can cancel a pending history.back()
// when the page replaces its URL in the meantime (closing a sheet often does),
// so popstate never arrives and every later sheet would wait on it forever.
// If it has not arrived after a second, stop waiting. A sheet entry that is
// still current becomes an ordinary entry in place; going back again instead
// could step out of the app if the first back was only slow.
function leaveSheetEntry() {
  clearTimeout(backWatchdog);
  history.back();
  backWatchdog = setTimeout(() => {
    if (pendingBack === null) return;
    const url = pendingBack;
    pendingBack = null;
    if (history.state?.loopSheet === true)
      history.replaceState({ ...history.state, loopSheet: false }, "", url);
    reconcile();
  }, 1000);
}
let scheduled = false;
const afterClose: (() => void)[] = [];

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
      leaveSheetEntry();
    } else if (!sheets.length && afterClose.length) {
      const callbacks = afterClose.splice(0);
      // Popstate's automatic scroll restoration happens after its listeners.
      // Navigation scrolls must run after that restoration and dialog focus.
      requestAnimationFrame(() => callbacks.forEach((callback) => callback()));
    }
  });
}

export function afterSheetsClose(callback: () => void) {
  afterClose.push(callback);
  reconcile();
}

export function closeTopSheet() {
  const sheet = sheets.at(-1);
  if (!sheet) return false;
  sheet.close();
  return true;
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    if (pendingBack !== null) {
      // The owning view may have cleared its conversation URL while closing.
      const url = pendingBack;
      pendingBack = null;
      clearTimeout(backWatchdog);
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
