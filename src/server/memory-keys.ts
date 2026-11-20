const structuralKey =
  /^ {0,3}(?:#{1,6}\s+(.+?)\s*#*|\*\*([^*\n]+)\*\*[^\n]*|((?:Decision|Decided|Outcome|Because|Next)\b[^\n]*))$/gimu;

const identifier =
  /https?:\/\/[^\s<>()[\]"`]+|(?<![\p{L}\p{N}_])#\d+\b|\b[0-9a-f]{7,40}\b|@[a-z0-9._-]+\/[a-z0-9._-]+|(?<![\p{L}\p{N}_])(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+|\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/giu;

const packageName =
  /(?:\b(?:npm (?:install|i)|pnpm add|yarn add)\s+|\b(?:from\s+|require\(\s*)["'])(@?[a-z0-9][a-z0-9._/-]*)/giu;

export function memoryKeys(content: string): string[] {
  const keys = new Set<string>();
  const add = (text: string) => {
    const key = text
      .trim()
      .replace(/^[`*]+|[`*.,:;]+$/g, "")
      .trim();
    if (key && key.length <= 160 && keys.size < 48) keys.add(key);
  };
  for (const match of content.matchAll(structuralKey))
    add(match[1] ?? match[2] ?? match[3]);
  for (const [text] of content.matchAll(identifier)) {
    if (/^https?:\/\//i.test(text)) {
      try {
        const url = new URL(text.replace(/[.,;]+$/, ""));
        add(url.hostname + url.pathname);
      } catch {
        continue;
      }
    } else add(text);
  }
  for (const match of content.matchAll(packageName)) add(match[1]);
  return [...keys];
}
