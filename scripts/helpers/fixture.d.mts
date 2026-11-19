import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

type FixtureProcess = EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

export function waitForFixtureAnnouncement(
  child: FixtureProcess,
  timeoutMs?: number,
): Promise<{ origin: string; pair: string }>;

export function pairDevice(
  origin: string,
  secret: string,
  name: string,
): Promise<{ cookie: string; csrf: string }>;
