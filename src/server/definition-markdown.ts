import { parseDocument } from "yaml";
import { z } from "zod";
import { agentInput, handle, Problem } from "./domain.js";
import {
  MAX_DEFINITION_BYTES,
  type DefinitionSpec,
} from "../shared/agent-definitions.js";

const metadata = {
  name: handle,
  description: z.string().trim().max(1000).default(""),
  model: agentInput.shape.model.optional(),
  effort: agentInput.shape.effort,
};
const role = z
  .object({
    ...metadata,
    instructions: z.string().trim().min(1).max(12000),
  })
  .strict();
const agent = z
  .object({ ...metadata, kind: z.literal("agent").default("agent") })
  .strict();
const team = z
  .object({
    kind: z.literal("team"),
    name: z.string().trim().min(1).max(80),
    description: metadata.description,
    manager: role,
    members: z.array(role).min(1).max(8),
  })
  .strict();

export function parseDefinition(markdown: string): DefinitionSpec {
  if (Buffer.byteLength(markdown, "utf8") > MAX_DEFINITION_BYTES)
    throw new Problem(400, "Markdown definitions must be at most 128 KB");
  const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(
    text,
  );
  if (!match)
    throw new Problem(
      400,
      "Start the file with YAML frontmatter between --- lines, followed by Markdown instructions",
    );
  let value: unknown;
  try {
    const document = parseDocument(match[1], { uniqueKeys: true });
    if (document.errors.length || document.warnings.length)
      throw new Error(
        [...document.errors, ...document.warnings]
          .map((e) => e.message)
          .join("; "),
      );
    // Definitions are data. Do not expand aliases, custom tags or merge keys.
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new Problem(
      400,
      `Invalid YAML frontmatter: ${(error as Error).message}`,
    );
  }
  const shared = match[2].trim();
  if (
    value &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "team"
  ) {
    const data = team.parse(value);
    const names = [
      data.manager.name,
      ...data.members.map((member) => member.name),
    ];
    if (new Set(names).size !== names.length)
      throw new Problem(400, "Every manager and worker needs a different name");
    const instructions = (member: z.infer<typeof role>) => ({
      ...member,
      instructions: agentInput.shape.instructions.parse(
        [shared, member.instructions].filter(Boolean).join("\n\n"),
      ),
    });
    return {
      ...data,
      manager: instructions(data.manager),
      members: data.members.map(instructions),
    };
  }
  return {
    ...agent.parse(value),
    instructions: z.string().min(1).max(12000).parse(shared),
  };
}
