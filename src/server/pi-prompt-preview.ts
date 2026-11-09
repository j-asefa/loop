/** Mirrors Pi 0.87.1 prompt-templates.ts argument parsing and substitutions. */
function parsePiArguments(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else current += char;
  }
  if (current) args.push(current);
  return args;
}

export function expandPiPrompt(content: string, input: string) {
  const args = parsePiArguments(input);
  const all = args.join(" ");
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (
      _match,
      target: string | undefined,
      fallback: string | undefined,
      start: string | undefined,
      length: string | undefined,
      simple: string | undefined,
    ) => {
      if (target)
        return (
          (target === "@" || target === "ARGUMENTS"
            ? all
            : args[Number(target) - 1]) ||
          fallback ||
          ""
        );
      if (start) {
        const offset = Math.max(0, Number(start) - 1);
        return args
          .slice(offset, length ? offset + Number(length) : undefined)
          .join(" ");
      }
      if (simple === "@" || simple === "ARGUMENTS") return all;
      return args[Number(simple) - 1] || "";
    },
  );
}

/**
 * The template body as Pi 0.87.1's extractFrontmatter sees it: BOM removed,
 * newlines normalized, frontmatter closed by the first "\n---", body trimmed.
 */
export function piPromptBody(raw: string) {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  return end === -1 ? text : text.slice(end + 4).trim();
}
