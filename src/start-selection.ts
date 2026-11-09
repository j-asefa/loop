import {
  harnesses,
  RuntimeHarness,
  runtimeHarnessIds,
  type Harness,
} from "./shared/harnesses.js";
export function selectedHarnesses(value = "installed"): Harness[] {
  const aliases: Record<string, string> = {
    installed: runtimeHarnessIds.join(","),
    both: "codex,claude",
    openai: "codex",
    anthropic: "claude",
  };
  const names = [
    ...new Set((aliases[value] || value).split(",").map((s) => s.trim())),
  ];
  if (
    !names.length ||
    names.some((name) => !RuntimeHarness.safeParse(name).success)
  )
    throw new Error(
      `Choose installed, ${runtimeHarnessIds.slice(0, -1).join(", ")} or ${runtimeHarnessIds.at(-1)}. Register custom ACP agents with loop acp --executable PATH.`,
    );
  return names as Harness[];
}

export function selectedBilling(
  name: Harness,
  explicit?: string,
  saved?: string,
): "existing" | "subscription" {
  // OpenCode's CLI asks for consent before using potentially paid native
  // configuration. Preserve that prompt instead of silently opting in.
  const billing =
    explicit ??
    saved ??
    (harnesses[name].billing.cliConsent
      ? "subscription"
      : harnesses[name].billing.default);
  if (billing !== "subscription" && billing !== "existing")
    throw new Error("Billing must be subscription or existing.");
  return billing;
}
