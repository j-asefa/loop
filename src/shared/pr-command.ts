import { parsePullRequestUrls } from "./github.js";

// Decode literal shell words, including shlex's adjacent quoted/escaped parts.
// Never evaluate expansions. Only successful && chains are accepted: a later
// fallback, pipeline or separate command cannot stand in for PR creation.
export function shellWords(script: string): (string | null)[] | undefined {
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
    } else if (c === "\n") return;
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

/** Extract a PR reference only from a completed creation command. */
export function createdPullRequest(command: string, output: string) {
  let tokens = shellWords(command);
  if (!tokens) return;
  if (
    tokens.length === 3 &&
    /^(?:\/bin\/)?(?:bash|sh|zsh)$/.test(tokens[0] || "") &&
    /^-[eilx]*c$/.test(tokens[1] || "")
  )
    tokens = shellWords(tokens[2] || "");
  if (!tokens?.length || tokens[0] === null || tokens.at(-1) === null) return;
  const start = tokens.lastIndexOf(null) + 1;
  if (
    tokens[start] !== "gh" ||
    tokens[start + 1] !== "pr" ||
    tokens[start + 2] !== "create"
  )
    return;
  const refs = parsePullRequestUrls(output, 2);
  return refs.length === 1 ? refs[0] : undefined;
}
