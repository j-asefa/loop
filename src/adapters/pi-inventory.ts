import type { NativeCommand } from "./types.js";

type SourceInfo = NativeCommand["sourceInfo"];
export type PiResource = {
  name: string;
  description: string;
  kind: "skill" | "prompt" | "extension" | "tool";
  token?: string;
  active?: boolean;
  scope?: string;
  source?: string;
  package?: string;
  path?: string;
};

function provenance(info?: SourceInfo) {
  return {
    scope: info?.scope,
    source: info?.source,
    package: info?.origin === "package" ? info.baseDir : undefined,
    path: info?.path,
  };
}

/** Pi's loaded catalog is authoritative; package groups are inferred from sourceInfo. */
export function piInventory(
  commands: NativeCommand[],
  tools: Array<{
    name: string;
    description?: string;
    sourceInfo?: SourceInfo;
    active?: boolean;
  }> = [],
  state?: {
    model?: { provider?: string; id?: string; name?: string };
    thinkingLevel?: string;
  },
) {
  const resources: PiResource[] = commands.map((command) => ({
    name: command.name,
    description: command.description,
    kind:
      command.kind === "skill"
        ? "skill"
        : command.kind === "prompt"
          ? "prompt"
          : "extension",
    token: command.token,
    ...provenance(command.sourceInfo),
  }));
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string") continue;
    resources.push({
      name: tool.name,
      description: tool.description || "",
      kind: "tool",
      active: tool.active === true,
      ...provenance(tool.sourceInfo),
    });
  }
  const packages = [
    ...new Set(resources.map((r) => r.package).filter((p): p is string => !!p)),
  ].map((path) => ({
    path,
    name: path.split(/[\\/]/).filter(Boolean).at(-1) || path,
    resources: resources.filter((r) => r.package === path).length,
  }));
  return {
    resources,
    packages,
    model: state?.model && {
      provider: state.model.provider,
      id: state.model.id,
      name: state.model.name,
    },
    thinkingLevel: state?.thinkingLevel,
    source: "Pi RPC and loaded extension metadata",
  };
}
