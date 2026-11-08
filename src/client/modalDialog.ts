import { lockSheetPage } from "./sheet-scroll";
import { registerSheet } from "./sheetHistory";

const dialogs: HTMLDialogElement[] = [];
export const topSheet = () => dialogs.at(-1) || null;

export function openModalDialog(dialog: HTMLDialogElement, close: () => void) {
  const opener = document.activeElement as HTMLElement | null;
  const unlockPage = lockSheetPage();
  try {
    dialog.showModal();
  } catch (error) {
    unlockPage();
    throw error;
  }
  dialogs.push(dialog);
  const unregister = registerSheet(close);
  return () => {
    dialog.close();
    const index = dialogs.indexOf(dialog);
    if (index >= 0) dialogs.splice(index, 1);
    unregister();
    unlockPage();
    // Removing a dialog also removes the browser's focus-restoration target.
    // Do not move focus outside another modal that remains open.
    if (
      opener?.isConnected &&
      (!document.querySelector("dialog[open]") ||
        opener.closest("dialog[open]"))
    )
      opener.focus({ preventScroll: true });
  };
}
