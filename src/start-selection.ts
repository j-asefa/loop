import type { Harness } from "./protocol.js";
export function selectedHarnesses(value = "installed"): Harness[] {
  const aliases: Record<string, string> = {
    installed: "codex,claude,pi,opencode,gemini",
    both: "codex,claude",
    openai: "codex",
    anthropic: "claude",
  };
  const names = [
    ...new Set((aliases[value] || value).split(",").map((s) => s.trim())),
  ];
  if (
    !names.length ||
    names.some(
      (n) => !["codex", "claude", "pi", "opencode", "gemini"].includes(n),
    )
  )
    throw new Error(
      "Choose installed, codex, claude, pi, opencode or gemini. Register custom ACP agents with loop acp --executable PATH.",
    );
  return names as Harness[];
}
