import type { WorkspaceFrame } from "./workspace-events";
import { viewGeneration } from "./viewCache";

export type ProjectionFrame = {
  source: string;
  generation: number;
  frame: WorkspaceFrame;
};
export function publishProjectionFrame(source: string, frame: WorkspaceFrame) {
  window.dispatchEvent(
    new CustomEvent<ProjectionFrame>("loop-workspace-frame", {
      detail: { source, generation: viewGeneration(), frame },
    }),
  );
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
