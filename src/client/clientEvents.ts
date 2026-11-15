export type ClientEvents = {
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
