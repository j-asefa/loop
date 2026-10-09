import { authorizedFetch } from "./api";

/** Opt-in, short-lived physical-device capture. No text, URLs, IDs or form
 * values: only viewport geometry, element bounds and numeric CSS flags. */
export function startViewportDiagnostics() {
  if (new URL(location.href).searchParams.get("viewportDebug") !== "feed-reply")
    return;
  const session = crypto.randomUUID();
  const started = performance.now();
  let batch: unknown[] = [];
  const box = (el: Element | null) => {
    if (!el) return [];
    const r = el.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height];
  };
  const flush = () => {
    if (!batch.length) return;
    const samples = batch.splice(0);
    void authorizedFetch("/api/ui/viewport-diagnostics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session, samples }),
    }).catch(() => {});
  };
  const capture = () => {
    const v = visualViewport;
    const dialog =
      [...document.querySelectorAll("dialog[open]")].at(-1) || null;
    const input = dialog?.querySelector("textarea") || null;
    const css = dialog && getComputedStyle(dialog);
    const r = input?.getBoundingClientRect();
    const hit =
      r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    batch.push({
      elapsed: Math.round(performance.now() - started),
      viewport: [
        innerWidth,
        innerHeight,
        scrollX,
        scrollY,
        document.documentElement.clientHeight,
        v?.height || 0,
        v?.offsetTop || 0,
        v?.pageTop || 0,
        v?.scale || 0,
      ],
      dialog: box(dialog),
      header: box(dialog?.querySelector(".sheet-head") || null),
      input: box(input),
      body: box(document.body),
      flags: [
        document.documentElement.dataset.keyboard === "open" ? 1 : 0,
        input === document.activeElement ? 1 : 0,
        input === hit ? 1 : 0,
        css?.position === "fixed" ? 1 : 0,
        css?.transform === "none" ? 1 : 0,
        css?.translate === "none" ? 1 : 0,
        dialog?.scrollTop || 0,
        Number.parseFloat(
          css?.getPropertyValue("--sheet-top-correction") || "0",
        ) || 0,
      ],
    });
    if (batch.length >= 8) flush();
  };
  capture();
  const timer = setInterval(capture, 500);
  setTimeout(() => {
    clearInterval(timer);
    flush();
  }, 120_000);
}
