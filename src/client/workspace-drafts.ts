import { viewGeneration, viewOwner } from "./viewCache";
import type { ComposerContext } from "./composerContext";
import type { SharedDraft } from "./Sharing";

export type WorkspaceComposerDraft = {
  selected: string;
  replyContext: ComposerContext | null;
  folderChoice?: string;
};

/** Capture the authenticated owner and view generation before handing a
 * persistence callback to a component. Unattributed legacy keys are not read. */
export function sessionDraft<T>(
  owner: string | undefined,
  source: string,
  kind: "composer" | "share" | "agent-tab",
  entity = "",
) {
  const generation = viewGeneration();
  const key = `loop55-workspace-draft:${JSON.stringify([owner, source, kind, entity])}`;
  const current = () =>
    !!owner && owner === viewOwner() && generation === viewGeneration();
  return {
    key,
    read(): T | undefined {
      if (!current()) return;
      try {
        const value = sessionStorage.getItem(key);
        return value ? (JSON.parse(value) as T) : undefined;
      } catch {
        return;
      }
    },
    write(value: T | undefined) {
      if (!current()) return;
      try {
        if (value === undefined) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* A full/disabled storage does not discard the in-memory draft. */
      }
    },
  };
}

export const emptySharedDraft = (): SharedDraft => ({
  url: "",
  title: "",
  excerpt: "",
  question: "",
  folderId: "",
});
