// Decode literal words without evaluating shell expansions. A null token marks
// an && boundary; other shell control operators are rejected.
export function shellWords(
  script: string,
  // Strict: an unquoted newline is a command separator, so the script is
  // not one literal chain. Pull request detection keeps accepting it.
  options: { strict?: boolean } = {},
): (string | null)[] | undefined {
  const result: (string | null)[] = [];
  let word = "",
    started = false,
    quote = "";
  const flush = () => {
    if (started) result.push(word);
    word = "";
    started = false;
  };
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (quote === "'") {
      if (c === "'") quote = "";
      else word += c;
    } else if (c === "\\") {
      if (++i >= script.length) return;
      const next = script[i];
      if (quote === '"' && !["$", "`", '"', "\\", "\n"].includes(next))
        word += "\\";
      if (next !== "\n") word += next;
      started = true;
    } else if (quote === '"') {
      if (c === '"') quote = "";
      else if (c === "$" || c === "`") return;
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\n" && options.strict) return;
    else if (/\s/.test(c)) flush();
    else if (c === "&" && script[i + 1] === "&") {
      flush();
      result.push(null);
      i++;
    } else if (/[;&|<>`$()#]/.test(c)) return;
    else {
      word += c;
      started = true;
    }
  }
  if (quote) return;
  flush();
  return result;
}
