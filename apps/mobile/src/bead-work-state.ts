export type BeadTarget = { projectId: string; storeId: string; beadId: string };
export type BeadDraft = { text: string; excerpt?: string; requestId?: string };

export function beadDraftScope(target: BeadTarget) {
  return JSON.stringify([
    "bead-comment",
    target.projectId,
    target.storeId,
    target.beadId,
  ]);
}

export function workSelection(description: string, start: number, end: number) {
  return description.slice(start, end).trim();
}

export function prepareBeadComment(
  target: BeadTarget,
  draft: BeadDraft,
  newId: () => string,
) {
  return {
    target,
    scope: beadDraftScope(target),
    draft: { ...draft, requestId: draft.requestId || newId() },
  };
}

export function workPageIndex(
  items: readonly { id: string }[],
  active: string,
) {
  return Math.max(
    0,
    items.findIndex(({ id }) => id === active),
  );
}
