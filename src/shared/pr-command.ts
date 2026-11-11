import { parsePullRequestUrls } from "./github.js";
import { shellWords } from "./shell-words.js";

/** Extract a PR reference only from a completed creation command. */
export function createdPullRequest(command: string, output: string) {
  let tokens = shellWords(command);
  if (!tokens) return;
  if (
    tokens.length === 3 &&
    /^(?:\/bin\/)?(?:bash|sh|zsh)$/.test(tokens[0] || "") &&
    /^-[a-z]*c$/.test(tokens[1] || "")
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
