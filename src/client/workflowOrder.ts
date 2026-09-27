type Step = { id: string; source?: string; [key: string]: unknown };

export function reorderSteps<T extends Step>(
  steps: T[],
  index: number,
  direction: number,
): T[] | null {
  const target = index + direction;
  if (
    !Number.isInteger(index) ||
    ![-1, 1].includes(direction) ||
    index < 0 ||
    index >= steps.length ||
    target < 0 ||
    target >= steps.length
  )
    return null;
  const result = [...steps];
  [result[index], result[target]] = [result[target], result[index]];
  // Keep producers before every consumer, including references inside prompts.
  const seen = new Set<string>();
  for (const step of result) {
    const references = [
      ...JSON.stringify(step).matchAll(/steps\.([a-zA-Z0-9_-]+)/g),
    ].map((match) => match[1]);
    if (step.source) references.push(step.source);
    if (references.some((reference) => !seen.has(reference))) return null;
    seen.add(step.id);
  }
  return result;
}
