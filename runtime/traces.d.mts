import type { Chunk } from "../src/server/providers.js";
export function codexTrace(
  message: any,
  messages?: Map<string, any>,
): Chunk["trace"];
export function claudeTraces(
  message: any,
  internalToolIds?: Set<string>,
): NonNullable<Chunk["trace"]>[];
export function codexActivity(message: any): Chunk["activity"];
export function claudeActivities(
  message: any,
  pending?: Set<string>,
): NonNullable<Chunk["activity"]>[];
