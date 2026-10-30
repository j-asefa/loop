/** Read-only event sink shared by real sockets and gateway logical sources. */
export interface EventSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
  on(event: "close" | "message", listener: () => void): unknown;
}
