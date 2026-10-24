import {
  PARTIAL_WORKSPACE_CAPABILITIES,
  type WorkspaceCapabilities,
} from "../shared/workspace-events";
import type { WorkspaceFrame } from "./workspace-events";
import { viewGeneration } from "./viewCache";

export type ProjectionFrame = {
  source: string;
  generation: number;
  frame: WorkspaceFrame;
};
let generation = -1;
const sources = new Map<string, WorkspaceCapabilities>();
function current() {
  if (generation !== viewGeneration()) {
    sources.clear();
    generation = viewGeneration();
  }
}
export function projectionCapabilities(source: string) {
  current();
  return sources.get(source) ?? PARTIAL_WORKSPACE_CAPABILITIES;
}
export function publishProjectionFrame(source: string, frame: WorkspaceFrame) {
  current();
  const capabilities =
    frame.v === 2 ? PARTIAL_WORKSPACE_CAPABILITIES : frame.capabilities;
  if (capabilities) {
    const changed =
      JSON.stringify(sources.get(source)) !== JSON.stringify(capabilities);
    sources.set(source, capabilities);
    if (changed) window.dispatchEvent(new Event("loop-workspace-capabilities"));
  }
  window.dispatchEvent(
    new CustomEvent<ProjectionFrame>("loop-workspace-frame", {
      detail: { source, generation, frame },
    }),
  );
}
export function forgetProjectionSource(source: string) {
  current();
  sources.delete(source);
  window.dispatchEvent(new Event("loop-workspace-capabilities"));
}
export function listenProjectionFrames(
  source: string,
  read: (frame: WorkspaceFrame) => void,
) {
  const owner = viewGeneration();
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<ProjectionFrame>).detail;
    if (
      detail?.source === source &&
      detail.generation === owner &&
      viewGeneration() === owner
    )
      read(detail.frame);
  };
  window.addEventListener("loop-workspace-frame", listener);
  return () => window.removeEventListener("loop-workspace-frame", listener);
}
export type ReactiveSurface = "transcript" | "feed" | "results" | "workspace";
// Workspace controls depend on the complete transcript/Results producers;
// Feed page delivery is negotiated independently and keeps its own fallback.
export function reactiveSource(source: string, surface: ReactiveSurface) {
  const capabilities = projectionCapabilities(source);
  return (
    capabilities.invalidations === "complete" &&
    capabilities.deadlines &&
    (surface === "workspace"
      ? capabilities.transcript === "delta" &&
        capabilities.results === "delta"
      : capabilities[surface] === "delta")
  );
}
/** Legacy sources retain only their own safety poll. Complete sources use the
 * shared socket-down HTTP fallback, wake handlers and single deadline timer. */
export function surfaceFallback(
  sourceIds: string[],
  surface: ReactiveSurface,
  milliseconds: number,
  read: (sources: string[]) => void,
) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const missing = () =>
    sourceIds.filter((source) => !reactiveSource(source, surface));
  const reconcile = () => {
    clearInterval(timer);
    timer = undefined;
    if (missing().length)
      timer = setInterval(() => read(missing()), milliseconds);
  };
  window.addEventListener("loop-workspace-capabilities", reconcile);
  reconcile();
  return () => {
    clearInterval(timer);
    window.removeEventListener("loop-workspace-capabilities", reconcile);
  };
}
