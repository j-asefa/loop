import { useEffect, useLayoutEffect, useRef, useState } from "react";

export function useComposerFocus({
  ownerRef,
  navigationGeneration,
  conversation,
}: {
  ownerRef: { readonly current: string | undefined };
  navigationGeneration: { readonly current: number };
  conversation: string | null;
}) {
  const [composerExpanded, setComposerExpanded] = useState(false);
  const composerFocusRequest = useRef<number | null>(null);
  const [composerOptions, setComposerOptions] = useState(false);
  const composerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!composerExpanded && !conversation) setComposerOptions(false);
  }, [composerExpanded, conversation]);
  function focusRequestedComposer() {
    if (!ownerRef.current) return;
    if (composerFocusRequest.current !== navigationGeneration.current) return;
    const input = document.querySelector<HTMLTextAreaElement>("#composer");
    input?.focus();
    if (input && document.activeElement === input)
      composerFocusRequest.current = null;
  }
  useLayoutEffect(() => {
    // A frame callback can run before React reveals the input. Finish an
    // explicit focus request after commit, without focusing on other updates.
    if (composerExpanded) focusRequestedComposer();
  });
  function focusComposer() {
    if (!ownerRef.current) return;
    composerFocusRequest.current = navigationGeneration.current;
    setComposerExpanded(true);
    requestAnimationFrame(focusRequestedComposer);
  }
  // Focus a thread's composer once its sheet has opened, but only if that
  // thread is still open; a quick close must not expand the global composer.
  const openConversation = useRef(conversation);
  openConversation.current = conversation;
  function focusThreadComposer(id: string) {
    setTimeout(() => {
      if (openConversation.current === id) focusComposer();
    }, 350);
  }
  function collapseComposer() {
    composerFocusRequest.current = null;
    document.querySelector<HTMLTextAreaElement>("#composer")?.blur();
    setComposerExpanded(false);
    setComposerOptions(false);
  }
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if ((e.target as Element)?.closest?.("dialog[open]")) return;
      if (!composerRef.current?.contains(e.target as Node))
        setComposerExpanded(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  return {
    composerExpanded,
    setComposerExpanded,
    composerOptions,
    setComposerOptions,
    composerFocusRequest,
    composerRef,
    focusComposer,
    focusThreadComposer,
    collapseComposer,
  };
}
