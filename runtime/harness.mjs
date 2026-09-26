import { lines, turnPrompt, responseSchema } from "./protocol.mjs";
export class HarnessError extends Error {}

const validName = (name) =>
  typeof name === "string" && /^[\w.:-]{1,200}$/.test(name);
export function codexSkills(result) {
  if (!Array.isArray(result?.data))
    throw new Error("Skill discovery is unavailable");
  return result.data
    .flatMap((page) => page.skills || [])
    .filter(
      (skill) =>
        skill.enabled !== false &&
        validName(skill.name) &&
        typeof skill.path === "string",
    );
}
export function codexCatalog(result) {
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
export function latestPrompt(input) {
  const last = input.messages.at(-1);
  return last?.role === "user" ? last.content.trim() : "";
}
export function slashCommand(input) {
  const match = latestPrompt(input).match(/^\/([\w.:-]+)(?:\s|$)/);
  return match?.[1];
}
export async function codexTurn(rpc, threadId, input, nativeTools, cwd) {
  const command = slashCommand(input);
  if (nativeTools && command) {
    if (command !== "review")
      throw new HarnessError(
        "This Codex command is not available in Loop. Open Commands & skills to see supported actions.",
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
  return rpc.call("turn/start", {
    threadId,
    ...(input.effort ? { reasoningEffort: input.effort } : {}),
    input: [{ type: "text", text: turnPrompt(input, nativeTools) }, ...items],
    outputSchema: responseSchema,
  });
}

// The official SDK's initialize control message lists commands without sending
// a user prompt or spending a model turn. Do not read arbitrary host files.
export async function claudeCatalog(launch) {
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
    const commands = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Command discovery timed out")),
        20000,
      );
      const finish = (error, value) => {
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      p.once("error", (e) => finish(e));
      p.once("exit", () => finish(new Error("Command discovery stopped")));
      p.stdin.on("error", (e) => finish(e));
      lines(
        p.stdout,
        (m) => {
          if (
            m.type !== "control_response" ||
            m.response?.request_id !== "loop-catalog"
          )
            return;
          if (
            m.response.subtype !== "success" ||
            !Array.isArray(m.response.response?.commands)
          )
            finish(new Error("Command discovery is unavailable"));
          else finish(null, m.response.response.commands);
        },
        (e) => finish(e),
      );
      p.stdin.write(
        JSON.stringify({
          type: "control_request",
          request_id: "loop-catalog",
          request: { subtype: "initialize" },
        }) + "\n",
      );
    });
    return {
      available: true,
      runtime: "Claude Code",
      commands: commands
        .filter((c) => validName(c.name))
        .map((c) => ({
          name: c.name,
          token: "/" + c.name,
          kind: "command",
          description: c.description || "",
          argumentHint: c.argumentHint || "",
          ...([
            "clear",
            "compact",
            "resume",
            "rewind",
            "fork",
            "rename",
          ].includes(c.name)
            ? {
                disabledReason:
                  "Requires a persistent Claude terminal session. Loop keeps the conversation history here.",
              }
            : {}),
        })),
    };
  } finally {
    p.kill("SIGTERM");
  }
}
