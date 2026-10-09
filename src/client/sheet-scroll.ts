import { afterSheetsClose } from "./sheetHistory";

let locks = 0;
let restore: (() => void) | undefined;
let restoreHistory: (() => void) | undefined;
let savedY = 0;

export const pageScrollY = () => (locks ? savedY : window.scrollY);

/** Native modal inertness does not stop iOS from scrolling the document to a
 * focused field. Freeze the page underneath the entire modal stack; sheet
 * bodies keep their own scrolling. Restore the reading position only when the
 * last sheet closes, including when sheets close out of order. */
export function lockSheetPage() {
  if (locks++ === 0) {
    const { scrollX: x, scrollY: y } = window;
    savedY = y;
    // Freezing the body makes native history record scroll=0. Keep our saved
    // position in charge until the modal history entry has finished popping.
    if (!restoreHistory) {
      const mode = history.scrollRestoration;
      history.scrollRestoration = "manual";
      restoreHistory = () => {
        history.scrollRestoration = mode;
      };
    }
    const changes: [HTMLElement, string, string][] = [
      [document.documentElement, "overflow", "hidden"],
      [document.body, "position", "fixed"],
      [document.body, "top", `${-y}px`],
      [document.body, "left", `${-x}px`],
      [document.body, "width", "100%"],
    ];
    const previous = changes.map(([el, name, value]) => {
      const old = el.style.getPropertyValue(name);
      const priority = el.style.getPropertyPriority(name);
      el.style.setProperty(name, value);
      return () => {
        if (old) el.style.setProperty(name, old, priority);
        else el.style.removeProperty(name);
      };
    });
    restore = () => {
      for (const undo of previous) undo();
      window.scrollTo({ left: x, top: y, behavior: "instant" });
    };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--locks === 0) {
      restore?.();
      restore = undefined;
      afterSheetsClose(() => {
        if (!locks) {
          restoreHistory?.();
          restoreHistory = undefined;
        }
      });
    }
  };
}
