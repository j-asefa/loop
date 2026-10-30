import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { RuntimeInput } from "./types.ts";
export type HarnessCommand = {
  name: string;
  token: string;
  kind: string;
  description: string;
  argumentHint?: string;
  disabledReason?: string;
};
export type HarnessCatalog = {
  available: boolean;
  runtime?: string;
  commands: HarnessCommand[];
  message?: string;
};
type Launch = (
  command: string,
  args: string[],
) => ChildProcessWithoutNullStreams;
import { modelOptions } from "./model-options.ts";
import {
  lines,
  turnPrompt,
  responseSchema,
  nativeResponseSchema,
} from "./protocol.ts";
export class HarnessError extends Error {}

const validName = (name: unknown): name is string =>
  typeof name === "string" && /^[\w.:-]{1,200}$/.test(name);
export function codexSkills(result: any): {
  name: string;
  path: string;
  enabled?: boolean;
  description?: string;
  interface?: { shortDescription?: string };
}[] {
  if (!Array.isArray(result?.data))
    throw new Error("Skill discovery is unavailable");
  return result.data
    .flatMap((page: any) => page.skills || [])
    .filter(
      (skill: any) =>
        skill.enabled !== false &&
        validName(skill.name) &&
        typeof skill.path === "string",
    );
}
export function codexCatalog(result: unknown): HarnessCatalog {
  return {
    available: true,
    runtime: "Codex",
    commands: [
      {
        name: "review",
        token: "/review",
        kind: "command",
        description:
          "Review changes on this machine. Add instructions to focus the review.",
        argumentHint: "optional review instructions",
      },
      ...codexSkills(result).map((skill) => ({
        name: skill.name,
        token: "$" + skill.name,
        kind: "skill",
        description:
          skill.interface?.shortDescription || skill.description || "",
        argumentHint: "task for this skill",
      })),
    ],
  };
}
export function latestPrompt(input: RuntimeInput): string {
  const last = input.messages.at(-1);
  return last?.role === "user" ? last.content.trim() : "";
}
export function slashCommand(input: RuntimeInput): string | undefined {
  const match = latestPrompt(input).match(/^\/([\w.:-]+)(?:\s|$)/);
  return match?.[1];
}
export async function codexTurn(
  rpc: { call(method: string, params?: object): Promise<any> },
  threadId: string,
  input: RuntimeInput,
  nativeTools: boolean,
  cwd?: string,
  signal?: AbortSignal,
): Promise<{ turn: { id: string }; review?: boolean }> {
  signal?.throwIfAborted();
  const command = slashCommand(input);
  if (nativeTools && command) {
    if (command !== "review")
      throw new HarnessError(
        "This Codex command is not available in Loop55. Open Commands & skills to see supported actions.",
      );
    const instructions = latestPrompt(input).slice("/review".length).trim();
    const result = await rpc.call("review/start", {
      threadId,
      delivery: "inline",
      target: instructions
        ? { type: "custom", instructions }
        : { type: "uncommittedChanges" },
    });
    return { ...result, review: true };
  }
  const selected = nativeTools
    ? [
        ...(
          input.messages.findLast((m) => m.role === "user")?.content || ""
        ).matchAll(/(?:^|\s)\$([A-Za-z_][\w.:-]*)/g),
      ].map((m) => m[1])
    : [];
  const skills = selected.length
    ? codexSkills(
        await rpc.call("skills/list", {
          ...(cwd ? { cwds: [cwd] } : {}),
          forceReload: true,
        }),
      )
    : [];
  const items = [...new Set(selected)].flatMap((name) => {
    const matches = skills.filter((s) => s.name === name);
    // Shell variables and other dollar-prefixed text are ordinary prompt text
    // unless the host's skill catalog actually contains that name.
    if (!matches.length) return [];
    if (matches.length > 1)
      throw new HarnessError(
        `Skill $${name} is ambiguous on this machine. Refresh Commands & skills.`,
      );
    return [{ type: "skill", name, path: matches[0].path }];
  });
  // Skill discovery can finish after the run has been stopped or disconnected.
  signal?.throwIfAborted();
  return rpc.call("turn/start", {
    threadId,
    ...(input.effort ? { reasoningEffort: input.effort } : {}),
    input: [{ type: "text", text: turnPrompt(input, nativeTools) }, ...items],
    outputSchema:
      nativeTools || input.toolChoice
        ? nativeResponseSchema(input)
        : responseSchema,
  });
}

// The official SDK's initialize control message lists commands without sending
// a user prompt or spending a model turn. Do not read arbitrary host files.
async function claudeInitialize(launch: Launch): Promise<Record<string, any>> {
  const p = launch("claude", [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
  ]);
  try {
    const initialized = await new Promise<Record<string, any>>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Command discovery timed out")),
          20000,
        );
        const finish = (error: unknown, value?: Record<string, any>) => {
          clearTimeout(timer);
          error ? reject(error) : resolve(value!);
        };
        p.once("error", (e) => finish(e));
        p.once("exit", () => finish(new Error("Command discovery stopped")));
        p.stdin.on("error", (e) => finish(e));
        lines(
          p.stdout,
          (m) => {
            if (
              m.type !== "control_response" ||
              m.response?.request_id !== "loop55-catalog"
            )
              return;
            if (
              m.response.subtype !== "success" ||
              !m.response.response ||
              typeof m.response.response !== "object"
            )
              finish(new Error("Command discovery is unavailable"));
            else finish(null, m.response.response);
          },
          (e) => finish(e),
        );
        p.stdin.write(
          JSON.stringify({
            type: "control_request",
            request_id: "loop55-catalog",
            request: { subtype: "initialize" },
          }) + "\n",
        );
      },
    );
    return initialized;
  } finally {
    p.kill("SIGTERM");
  }
}

function claudeModelOptions(initialized: Record<string, any> | null) {
  const models = Array.isArray(initialized?.models)
    ? initialized.models
        .filter((model: any) => typeof (model?.value || model?.id) === "string")
        .map((model: any) => ({
          id: model.value || model.id,
          name: model.displayName || model.name || model.value || model.id,
          capabilities: "Claude Code · runtime model catalog",
          ...modelOptions(model),
        }))
    : [];
  if (models.length) return models;
  // Stable CLI aliases keep authenticated accounts usable on older runtimes or
  // during discovery failures. Do not invent effort levels or versioned IDs.
  // https://code.claude.com/docs/en/model-config#model-aliases
  return ["sonnet", "opus", "haiku"].map((id) => ({
    id,
    name: "Claude " + id[0].toUpperCase() + id.slice(1),
    capabilities: "Claude Code · model alias (catalog unavailable)",
  }));
}

export async function claudeModels(launch: Launch) {
  try {
    return claudeModelOptions(await claudeInitialize(launch));
  } catch {
    // Discovery is optional for account status. The caller has already checked
    // authentication with the official CLI; a catalog failure cannot undo it.
    return claudeModelOptions(null);
  }
}

export async function claudeCatalog(launch: Launch) {
  const initialized = await claudeInitialize(launch);
  if (!Array.isArray(initialized.commands))
    throw new Error("Command discovery is unavailable");
  return {
    available: true,
    runtime: "Claude Code",
    models: claudeModelOptions(initialized),
    commands: initialized.commands
      .filter((c: any) => validName(c?.name))
      .map((c: any) => ({
        name: c.name,
        token: "/" + c.name,
        kind: "command",
        description: c.description || "",
        argumentHint: c.argumentHint || "",
        ...(["clear", "compact", "resume", "rewind", "fork", "rename"].includes(
          c.name,
        )
          ? {
              disabledReason:
                "Requires a persistent Claude terminal session. Loop55 keeps the conversation history here.",
            }
          : {}),
      })),
  };
}
