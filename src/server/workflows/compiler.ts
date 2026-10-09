import { z } from "zod";
import { Problem, owned } from "../domain.js";
import type { Agent, Connection } from "../../shared/types.js";
import type { Snapshot } from "../agent-runtime.js";
const name = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const agentStep = z
  .object({
    id: name,
    type: z.literal("agent"),
    agent: name,
    prompt: z.string().min(1).max(12000),
  })
  .strict();
const approvalStep = z
  .object({
    id: name,
    type: z.literal("approval"),
    source: name,
    message: z.string().min(1).max(500),
  })
  .strict();
const saveStep = z
  .object({
    id: name,
    type: z.literal("save"),
    source: name,
    title: z.string().min(1).max(180),
    kind: z.enum(["markdown", "code", "table", "diagram"]).default("markdown"),
  })
  .strict();
export const workflowSchema = z
  .object({
    dsl: z.literal("loop.workflow/v1"),
    title: z.string().min(1).max(120),
    inputs: z.record(
      name,
      z
        .object({
          description: z.string().max(300),
          default: z.string().max(5000).optional(),
        })
        .strict(),
    ),
    agents: z.record(name, z.string().min(1)),
    steps: z
      .array(z.discriminatedUnion("type", [agentStep, approvalStep, saveStep]))
      .min(1)
      .max(20),
    outputs: z.record(name, name),
    folderId: z.string().nullable().default(null),
    limits: z
      .object({
        maxCalls: z.number().int().min(1).max(10).default(4),
        maxOutputTokens: z.number().int().min(64).max(4096).default(2048),
        maxInputBytes: z.number().int().min(100).max(100000).default(30000),
        maxRunSeconds: z.number().int().min(30).max(1800).default(600),
      })
      .default({
        maxCalls: 4,
        maxOutputTokens: 2048,
        maxInputBytes: 30000,
        maxRunSeconds: 600,
      }),
  })
  .strict();
export type Workflow = z.infer<typeof workflowSchema>;
export function compile(source: string): Workflow {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Problem(
      422,
      "Workflow source must be JSON using loop.workflow/v1",
    );
  }
  const spec = workflowSchema.parse(parsed);
  const seen = new Set<string>();
  let calls = 0;
  for (const step of spec.steps) {
    if (seen.has(step.id)) throw new Problem(422, `Duplicate step ${step.id}`);
    if (step.type === "agent") {
      calls++;
      if (!Object.hasOwn(spec.agents, step.agent))
        throw new Problem(422, `Unknown agent binding ${step.agent}`);
      for (const reference of step.prompt.matchAll(/\{\{([^{}]+)\}\}/g)) {
        const [scope, key, ...extra] = reference[1].trim().split(".");
        if (
          extra.length ||
          (scope === "inputs"
            ? !Object.hasOwn(spec.inputs, key)
            : scope === "steps"
              ? !seen.has(key)
              : true)
        )
          throw new Problem(
            422,
            `Invalid or forward reference ${reference[1]}`,
          );
      }
      if (step.prompt.replace(/\{\{[^{}]+\}\}/g, "").includes("{{"))
        throw new Problem(422, "Unclosed template reference");
    } else if (!seen.has(step.source))
      throw new Problem(
        422,
        `Step ${step.id} references an unavailable prior output`,
      );
    seen.add(step.id);
  }
  if (calls > spec.limits.maxCalls)
    throw new Problem(422, "Workflow exceeds its model-call budget");
  for (const step of Object.values(spec.outputs))
    if (!seen.has(step)) throw new Problem(422, `Unknown output ${step}`);
  if (!Object.keys(spec.outputs).length)
    throw new Problem(422, "Declare at least one named output");
  return spec;
}
export function bind(owner: string, spec: Workflow) {
  const snapshots: Record<string, Snapshot> = {};
  if (spec.folderId) owned("folders", spec.folderId, owner);
  for (const [role, agentId] of Object.entries(spec.agents)) {
    const agent = owned<Agent>("agents", agentId, owner);
    const connection = owned<Connection>(
      "connections",
      agent.connection_id || "",
      owner,
    );
    if (connection.status !== "connected")
      throw new Problem(409, `Reconnect @${agent.name} before running`);
    snapshots[role] = {
      agentId: agent.id,
      name: agent.name,
      provider: agent.provider,
      model: agent.model,
      effort: agent.effort,
      instructions: agent.instructions,
      connectionId: connection.id,
      folderId: spec.folderId,
    };
  }
  return snapshots;
}
export function interpolate(
  prompt: string,
  inputs: Record<string, string>,
  outputs: Record<string, string>,
) {
  return prompt.replace(/\{\{([^{}]+)\}\}/g, (_, ref: string) => {
    const [scope, name] = ref.trim().split(".");
    const values = scope === "inputs" ? inputs : outputs;
    if (!Object.hasOwn(values, name))
      throw new Problem(422, `Missing value ${ref}`);
    return values[name];
  });
}
