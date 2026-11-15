import {
  emitClientEvent,
  listenClientEvent,
  type ClientEvents,
  type WorkspaceFrame,
} from "./clientEvents";
import { viewGeneration } from "./viewCache";

export function publishProjectionFrame(source: string, frame: WorkspaceFrame) {
  emitClientEvent("loop-workspace-frame", {
    source,
    generation: viewGeneration(),
    frame,
  });
}
export function listenProjectionFrames(
  source: string,
  read: (frame: WorkspaceFrame) => void,
) {
  const owner = viewGeneration();
  const listener = (detail: ClientEvents["loop-workspace-frame"]) => {
    if (
      detail?.source === source &&
      detail.generation === owner &&
      viewGeneration() === owner
    )
      read(detail.frame);
  };
  return listenClientEvent("loop-workspace-frame", listener);
}
