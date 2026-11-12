import { parse } from "./api";

export const GLOBAL_DRAFT = "__global__";

export function sourceDraftId(id: string, source: string) {
  return JSON.stringify([source, id]);
}

// Drafts belong to the signed-in owner. Keys carry the owner so one account
// never reads another's unsent text on a shared device, and with no owner
// (signed out, expired) drafts are neither read nor written.
let currentOwner: string | undefined;
export function setDraftOwner(owner: string | undefined) {
  currentOwner = owner || undefined;
}
const key = (owner: string, kind: "text" | "files", id: string) =>
  `loop-draft-${kind}:${owner}:${id}`;

/** Unsent text and files for one thread, kept across app restarts. */
export function threadDraft(
  id: string,
  owner = currentOwner,
): { text: string; files: any[] } {
  if (!owner) return { text: "", files: [] };
  try {
    return {
      text: localStorage.getItem(key(owner, "text", id)) || "",
      files: parse(localStorage.getItem(key(owner, "files", id)) || "", []),
    };
  } catch {
    return { text: "", files: [] };
  }
}
export function saveThreadDraft(
  id: string,
  text: string,
  files: any[],
  owner = currentOwner,
) {
  if (!owner) return;
  try {
    if (text.trim()) localStorage.setItem(key(owner, "text", id), text);
    else localStorage.removeItem(key(owner, "text", id));
    if (files.length)
      localStorage.setItem(key(owner, "files", id), JSON.stringify(files));
    else localStorage.removeItem(key(owner, "files", id));
  } catch {}
}

type DraftIdentity = { text: string; files: readonly { id: string }[] };

export function sameDraft(a: DraftIdentity, b: DraftIdentity): boolean {
  return (
    a.text === b.text &&
    JSON.stringify(a.files.map((file) => file.id)) ===
      JSON.stringify(b.files.map((file) => file.id))
  );
}

/** Settle the originating composer's draft, even after its view has changed. */
export function clearAcceptedDraft(
  id: string,
  text: string,
  files: { id: string }[],
  owner?: string,
) {
  const saved = threadDraft(id, owner);
  if (sameDraft(saved, { text, files })) saveThreadDraft(id, "", [], owner);
}
