import type { Harness } from "./protocol.js";
export function selectedHarnesses(value = "installed"): Harness[] {
  const aliases: Record<string, string> = {
    installed: "codex,claude,pi,opencode,antigravity,muse,grok",
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
      (n) =>
        ![
          "codex",
          "claude",
          "pi",
          "opencode",
          "antigravity",
          "gemini",
          "muse",
          "grok",
        ].includes(n),
    )
  )
    throw new Error(
      "Choose installed, codex, claude, pi, opencode, antigravity, muse or grok (legacy: gemini). Register custom ACP agents with loop55 acp --executable PATH.",
    );
  return names as Harness[];
}
