import type { ChatInput, Chunk } from "../src/server/providers.js";

export const responseSchema: Record<string, unknown>;
export function turnPrompt(input: ChatInput, nativeTools?: boolean): string;
export function resultChunks(value: unknown, input: ChatInput): Chunk[];
