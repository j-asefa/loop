import { withOptionalStorage } from "./browserStorage";
import { viewGeneration, viewOwner } from "./viewCache";
import type { ComposerContext } from "./composerContext";

export type WorkspaceComposerDraft = {
  selected: string;
  replyContext: ComposerContext | null;
  folderChoice?: string;
};

/** Capture the authenticated owner and view generation before handing a
 * persistence callback to a component. Only this owner/source namespace is read. */
export function sessionDraft<T>(
  owner: string | undefined,
  source: string,
  kind: "composer" | "share" | "agent-tab",
  entity = "",
) {
  const generation = viewGeneration();
  const key = `loop-workspace-draft:${JSON.stringify([owner, source, kind, entity])}`;
  const current = () =>
    !!owner && owner === viewOwner() && generation === viewGeneration();
  return {
    key,
    read(): T | undefined {
      if (!current()) return;
      return withOptionalStorage(
        "session",
        (storage) => {
          const value = storage.getItem(key);
          return value ? (JSON.parse(value) as T) : undefined;
        },
        undefined,
      );
    },
    write(value: T | undefined) {
      if (!current()) return;
      withOptionalStorage(
        "session",
        (storage) => {
          if (value === undefined) storage.removeItem(key);
          else storage.setItem(key, JSON.stringify(value));
        },
        undefined,
      );
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

export type SharedDraft = {
  url: string;
  title: string;
  excerpt: string;
  question: string;
  folderId: string;
};
export function initialShare(url = new URL(location.href)): SharedDraft {
  const q = url.searchParams;
  return q.has("share") || url.pathname === "/share"
    ? {
        url:
          q.get("url") ||
          (q.get("text") || "").trim().match(/^https?:\/\/\S+$/)?.[0] ||
          "",
        title: q.get("title") || "",
        excerpt: q.get("text") || "",
        question: q.get("question") || "",
        folderId: q.get("folder") || "",
      }
    : emptySharedDraft();
}
