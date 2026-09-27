/** HAPI uses positional Claude answers and stable Codex question IDs. */
export function nativeQuestionKey(
  tool: string | undefined,
  question: { id?: string },
  index: number,
): string {
  return tool === "AskUserQuestion"
    ? String(index)
    : question.id || String(index);
}
