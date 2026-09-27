import type { Chunk } from "../src/server/providers.js";
export function codexTrace(
  message: any,
  messages?: Map<string, any>,
): Chunk["trace"];
export function claudeTraces(
  message: any,
  internalToolIds?: Set<string>,
): NonNullable<Chunk["trace"]>[];
