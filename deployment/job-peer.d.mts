import type { Socket } from "node:net";
export function peerIsSameUser(socket: Socket, uid?: number): Promise<boolean>;
