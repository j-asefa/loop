import { useEffect, useRef, useState, type RefObject } from "react";
import { useLongPress, useSwipe } from "./ThreadTools";

const CARD_TYPE = "application/x-loop-done-card";
const controls = "a,button,summary,input,textarea,select,pre,.table-scroll";
export type CardDragSession = {
  source: string;
  target: HTMLElement | null;
};

/** Hold then release for actions; hold then move to combine. A quick swipe
 * still dismisses, and movement before the hold leaves scrolling alone. */
export function useDoneCardGestures({
  id,
  session,
  onMenu,
  onAggregate,
  onDismiss,
}: {
  id?: string;
  session: RefObject<CardDragSession | null>;
  onMenu: () => void;
  onAggregate: (source: string, target: string) => void;
  onDismiss?: () => void;
}) {
  const swipe = useSwipe({ onLeft: onDismiss });
  const press = useLongPress(onMenu, !id);
  const [lifted, setLifted] = useState(false);
  const [dragging, setDragging] = useState(false);
  const active = useRef<{
    pointer: number;
    touch: boolean;
    x: number;
    y: number;
    held: boolean;
    moved: boolean;
    element: HTMLElement;
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const stopTouch = useRef<(() => void) | undefined>(undefined);
  const suppressClick = useRef(false);
  const stopReleaseClick = useRef<(() => void) | undefined>(undefined);
  const blockReleaseClick = () => {
    stopReleaseClick.current?.();
    // Opening a modal on pointerup can retarget the compatibility click to
    // its backdrop. Capture that click before it dismisses the new sheet.
    const clear = () => {
      window.removeEventListener("click", block, true);
      window.removeEventListener("pointerdown", clear, true);
      clearTimeout(timeout);
      stopReleaseClick.current = undefined;
    };
    const block = (event: MouseEvent) => {
      clear();
      if (!event.detail) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const timeout = setTimeout(clear, 1000);
    window.addEventListener("click", block, true);
    window.addEventListener("pointerdown", clear, true);
    stopReleaseClick.current = clear;
  };
  const point = useRef({ x: 0, y: 0 });
  const clearTimer = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  const setTarget = (target: HTMLElement | null) => {
    const current = session.current;
    if (!current) return;
    current.target?.classList.remove("card-drop-target");
    current.target = target;
    target?.classList.add("card-drop-target");
  };
  const findTarget = (x: number, y: number) => {
    const element = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-done-card]");
    // A drag belongs to this Feed, even if another list is mounted nearby.
    const list = active.current?.element.closest(".feed-results");
    return element && element.dataset.doneCard !== id && list?.contains(element)
      ? element
      : null;
  };
  const cleanup = () => {
    clearTimer();
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    stopTouch.current?.();
    stopTouch.current = undefined;
    active.current = null;
    if (session.current?.source === id) {
      setTarget(null);
      session.current = null;
    }
  };
  const cancel = () => {
    if (active.current?.held || session.current?.source === id)
      suppressClick.current = true;
    cleanup();
    setLifted(false);
    setDragging(false);
    swipe.handlers.onPointerCancel();
  };
  useEffect(() => {
    setLifted(false);
    setDragging(false);
    return () => {
      cleanup();
      stopReleaseClick.current?.();
    };
  }, [id, session]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && active.current) cancel();
    };
    const blur = () => {
      if (active.current) cancel();
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", blur);
    };
  });
  const scroll = () => {
    const gesture = active.current;
    if (!gesture?.held || !gesture.moved) return;
    let scroller: HTMLElement | null = gesture.element.parentElement;
    while (
      scroller &&
      !(
        scroller.scrollHeight > scroller.clientHeight &&
        /auto|scroll/.test(getComputedStyle(scroller).overflowY)
      )
    )
      scroller = scroller.parentElement;
    scroller ??= document.scrollingElement as HTMLElement;
    const bounds = scroller.getBoundingClientRect();
    const top = Math.max(0, bounds.top),
      bottom = Math.min(innerHeight, bounds.bottom);
    const y = point.current.y;
    const speed = y < top + 64 ? -10 : y > bottom - 64 ? 10 : 0;
    if (speed) {
      scroller.scrollTop += speed;
      setTarget(findTarget(point.current.x, y));
    }
    frame.current = requestAnimationFrame(scroll);
  };
  const move = (x: number, y: number) => {
    const gesture = active.current;
    if (!gesture) return;
    point.current = { x, y };
    if (!gesture.moved && Math.hypot(x - gesture.x, y - gesture.y) <= 10)
      return;
    clearTimer();
    if (!gesture.held) return;
    gesture.moved = true;
    suppressClick.current = true;
    setDragging(true);
    setTarget(findTarget(x, y));
    if (frame.current === undefined)
      frame.current = requestAnimationFrame(scroll);
  };
  const merged =
    (
      name:
        "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel",
    ) =>
    (event: React.PointerEvent) => {
      swipe.handlers[name](event);
      press[name]?.(event);
    };
  if (!id)
    return {
      ...swipe,
      lifted: false,
      dragging: false,
      handlers: {
        onPointerDown: merged("onPointerDown"),
        onPointerMove: merged("onPointerMove"),
        onPointerUp: merged("onPointerUp"),
        onPointerCancel: merged("onPointerCancel"),
        onClickCapture: (event: React.MouseEvent) => {
          swipe.handlers.onClickCapture(event);
          press.onClickCapture?.(event);
        },
        onPointerLeave: press.onPointerLeave,
        onContextMenu: press.onContextMenu,
      },
    };
  return {
    ...swipe,
    lifted,
    dragging,
    handlers: {
      draggable: true,
      "data-done-card": id,
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
        // Native touch dragging competes with hold-to-combine. Mouse input
        // still uses the browser's drag image and HTML drop events.
        event.currentTarget.draggable = event.pointerType === "mouse";
        if (active.current) {
          cancel();
          return;
        }
        suppressClick.current = false;
        swipe.handlers.onPointerDown(event);
        if (
          event.button !== 0 ||
          !event.isPrimary ||
          (event.target as HTMLElement).closest(controls)
        )
          return;
        active.current = {
          pointer: event.pointerId,
          touch: event.pointerType !== "mouse",
          x: event.clientX,
          y: event.clientY,
          held: false,
          moved: false,
          element: event.currentTarget,
        };
        timer.current = setTimeout(() => {
          const gesture = active.current;
          if (!gesture) return;
          clearTimer();
          suppressClick.current = true;
          swipe.handlers.onPointerCancel();
          if (!gesture.touch) {
            cleanup();
            onMenu();
            return;
          }
          gesture.held = true;
          session.current = { source: id, target: null };
          setLifted(true);
          navigator.vibrate?.(10);
        }, 500);
        // React touch listeners are passive. Cancel native scrolling only
        // after a stationary hold; ordinary vertical swipes still scroll.
        const touchMove = (touch: TouchEvent) => {
          if (touch.touches.length !== 1) {
            cancel();
            return;
          }
          if (!active.current?.held) return;
          touch.preventDefault();
          move(touch.touches[0].clientX, touch.touches[0].clientY);
        };
        window.addEventListener("touchmove", touchMove, { passive: false });
        stopTouch.current = () =>
          window.removeEventListener("touchmove", touchMove);
      },
      onPointerMove: (event: React.PointerEvent) => {
        if (active.current?.pointer === event.pointerId)
          move(event.clientX, event.clientY);
        if (!active.current?.held) swipe.handlers.onPointerMove(event);
      },
      onPointerUp: (event: React.PointerEvent) => {
        const gesture = active.current;
        if (gesture && gesture.pointer !== event.pointerId) return;
        if (gesture?.held && gesture.pointer === event.pointerId) {
          const target = gesture.moved
            ? findTarget(event.clientX, event.clientY)?.dataset.doneCard
            : undefined;
          blockReleaseClick();
          cancel();
          if (target) onAggregate(id, target);
          else if (!gesture.moved) onMenu();
        } else {
          cleanup();
          swipe.handlers.onPointerUp();
        }
      },
      onPointerCancel: (event: React.PointerEvent) => {
        if (active.current && active.current.pointer !== event.pointerId)
          return;
        // Native HTML dragging cancels its pointer stream; dragend owns it.
        if (session.current?.source === id && !active.current?.touch) return;
        cancel();
      },
      onPointerLeave: () => {
        if (active.current && !active.current.touch && !active.current.held)
          clearTimer();
      },
      onContextMenu: (event: React.MouseEvent) => {
        if ((event.target as HTMLElement).closest(controls)) return;
        event.preventDefault();
        // Touch contextmenu can precede touchend. Keep the held card draggable.
        if (active.current?.touch) return;
        cancel();
        suppressClick.current = true;
        onMenu();
      },
      onClickCapture: (event: React.MouseEvent) => {
        if (suppressClick.current) {
          event.preventDefault();
          event.stopPropagation();
          suppressClick.current = false;
        } else swipe.handlers.onClickCapture(event);
      },
      onDragStart: (event: React.DragEvent<HTMLElement>) => {
        if (
          !active.current ||
          active.current.touch ||
          (event.target as HTMLElement).closest(controls)
        ) {
          event.preventDefault();
          return;
        }
        clearTimer();
        swipe.handlers.onPointerCancel();
        suppressClick.current = true;
        session.current = { source: id, target: null };
        event.dataTransfer.setData(CARD_TYPE, id);
        event.dataTransfer.effectAllowed = "link";
        setDragging(true);
      },
      onDragOver: (event: React.DragEvent<HTMLElement>) => {
        if (
          !session.current ||
          session.current.source === id ||
          !event.dataTransfer.types.includes(CARD_TYPE)
        )
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "link";
        setTarget(event.currentTarget);
      },
      onDragLeave: (event: React.DragEvent<HTMLElement>) => {
        if (
          !event.currentTarget.contains(event.relatedTarget as Node | null) &&
          session.current?.target === event.currentTarget
        )
          setTarget(null);
      },
      onDrop: (event: React.DragEvent) => {
        const source = session.current?.source;
        if (
          !source ||
          source === id ||
          event.dataTransfer.getData(CARD_TYPE) !== source
        )
          return;
        event.preventDefault();
        setTarget(null);
        onAggregate(source, id);
      },
      onDragEnd: cancel,
    },
  };
}
