import {
  ownedFolder,
  ownedAgent,
  ownedConnection,
  Problem,
} from "../domain.js";

import type { Snapshot } from "../agent-runtime.js";
import { workflowSchema, type Workflow } from "./schema.js";
export { workflowSchema, type Workflow } from "./schema.js";
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
  if (spec.folderId) ownedFolder(spec.folderId, owner);
  for (const [role, agentId] of Object.entries(spec.agents)) {
    const agent = ownedAgent(agentId, owner);
    const connection = ownedConnection(agent.connection_id || "", owner);
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
