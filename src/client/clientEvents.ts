import type {
  WorkspaceClock,
  WorkspaceFrameV3,
} from "../shared/workspace-events";

export type WorkspaceFrame =
  | WorkspaceFrameV3
  // A clock observed over HTTP can reset a replaced source, but cannot
  // identify that deployment's build.
  | (Omit<
      Extract<WorkspaceFrameV3, { type: "reset" }>,
      "build" | "buildIdentity"
    > & {
      build?: undefined;
      buildIdentity?: undefined;
    });

export type ClientEvents = {
  "loop-workspace-clock": {
    source: string;
    generation: number;
    requestId?: number;
    clock: WorkspaceClock;
  };
  "loop-workspace-frame": {
    source: string;
    generation: number;
    frame: WorkspaceFrame;
  };
  "loop-open-pull": string;
  "loop-tools-closed": undefined;
  "loop-pr-watch-change": undefined;
  "loop-show-later": {
    section: "all" | "saved" | "reminders" | "scheduled";
    focusId: string | null;
  };
  "loop-refresh": undefined;
  "loop-source-refresh": undefined;
  "loop-later-change": undefined;
  "loop-scheduled-change": undefined;
  "loop-social-read": undefined;
  "loop-auth-expired": undefined;
  "loop-reconnecting": undefined;
  "loop-toast": {
    id: string;
    text: string;
    tone?: "error";
    link?: { label: string; onSelect: () => void };
    undo?: () => Promise<void> | void;
    onExpire?: () => void;
  };
};

export function emitClientEvent<K extends keyof ClientEvents>(
  name: K,
  ...args: ClientEvents[K] extends undefined ? [] : [detail: ClientEvents[K]]
) {
  const detail = args[0];
  window.dispatchEvent(
    detail === undefined ? new Event(name) : new CustomEvent(name, { detail }),
  );
}

export function listenClientEvent<K extends keyof ClientEvents>(
  name: K,
  receive: (detail: ClientEvents[K]) => void,
) {
  const listener = (event: Event) =>
    receive((event as CustomEvent<ClientEvents[K]>).detail);
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
}
