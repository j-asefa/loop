import { LEADING_REPLY_PREFIX } from "../shared/display-spec";
import type { ComposerContext } from "./composerContext";
import { viewOwner } from "./viewCache";
import { withOptionalStorage } from "./browserStorage";
import { parse } from "./json";

export function appendDraftText(current: string, added: string): string {
  return current.trim() ? `${current.trimEnd()}\n\n${added}` : added;
}

export function replyButtonBlockReason(
  currentContext: ComposerContext | null,
  nextContext: ComposerContext,
  currentDraft: string,
): string {
  if (!currentDraft.trim()) return "";
  if (LEADING_REPLY_PREFIX.test(currentDraft))
    return "Send or clear your current draft before using a reply button.";
  if (
    currentContext?.conversationId === nextContext.conversationId &&
    currentContext?.messageId &&
    currentContext.messageId !== nextContext.messageId
  )
    return "Send or clear your reply to the other message before using this reply button.";
  return "";
}

export function seedReplyDraftText(current: string, prompt: string): string {
  const trimmed = current.trimEnd();
  if (!trimmed.trim()) return prompt;
  if (LEADING_REPLY_PREFIX.test(trimmed)) return current;
  const target = prompt.trimEnd();
  if (trimmed === target || trimmed.endsWith(`\n\n${target}`)) return current;
  return `${trimmed}\n\n${prompt}`;
}

export function resolveReplyContext(
  current: ComposerContext | null,
  next: ComposerContext,
  hasText: boolean,
  switching: boolean,
  currentDraft = "",
): ComposerContext | null {
  if (
    hasText &&
    !switching &&
    replyButtonBlockReason(current, next, currentDraft)
  )
    return current;
  if (
    hasText &&
    !switching &&
    current?.conversationId === next.conversationId &&
    current?.agentId === next.agentId &&
    current?.messageId === next.messageId &&
    Boolean(current?.excerpt) &&
    !next.excerpt
  )
    return current;
  return next;
}

export const GLOBAL_DRAFT = "__global__";

export function sourceDraftId(id: string, source: string) {
  return JSON.stringify([source, id]);
}

const key = (owner: string, kind: "text" | "files", id: string) =>
  `loop-draft-${kind}:${owner}:${id}`;

/** Unsent text and files for one thread, kept across app restarts. */
export function threadDraft(
  id: string,
  owner = viewOwner(),
): { text: string; files: any[] } {
  if (!owner) return { text: "", files: [] };
  return withOptionalStorage(
    "local",
    (storage) => {
      return {
        text: storage.getItem(key(owner, "text", id)) || "",
        files: parse<unknown[]>(
          storage.getItem(key(owner, "files", id)) || "",
          [],
        ),
      };
    },
    { text: "", files: [] },
  );
}
export function saveThreadDraft(
  id: string,
  text: string,
  files: any[],
  owner = viewOwner(),
) {
  if (!owner) return;
  withOptionalStorage(
    "local",
    (storage) => {
      if (text.trim()) storage.setItem(key(owner, "text", id), text);
      else storage.removeItem(key(owner, "text", id));
      if (files.length)
        storage.setItem(key(owner, "files", id), JSON.stringify(files));
      else storage.removeItem(key(owner, "files", id));
    },
    undefined,
  );
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
