import {
  agentWorkspace,
  prepareAgentWorkspace,
  verifyAgentWorkspace,
  AgentWorktreeError,
  type AgentWorkspace,
} from "../agent-worktree.js";
import { config } from "../config.js";
import { realpathSync } from "node:fs";
import { Problem } from "../domain.js";
import { type Harness } from "../../protocol.js";
import { OWNER, type Binding } from "./state.js";

export function prepareWorkspace(...args: Parameters<typeof agentWorkspace>) {
  try {
    return agentWorkspace(...args);
  } catch (error) {
    workspaceError(error);
  }
}

export async function prepareImportedWorkspace(
  project: string,
  agentId: string,
  harness: Harness,
  expected?: AgentWorkspace,
) {
  try {
    const identity = {
      ownerId: OWNER,
      agentId,
      environmentId: realpathSync(config.data),
      projectId: project,
    };
    return expected
      ? await verifyAgentWorkspace(project, project, identity, expected)
      : await prepareAgentWorkspace(
          project,
          project,
          identity,
          harness === "codex",
        );
  } catch (error) {
    workspaceError(error);
  }
}

export function workspaceError(error: unknown): never {
  // These messages are controlled setup guidance, not raw Git/filesystem output.
  if (error instanceof AgentWorktreeError)
    throw new Problem(409, error.message);
  if (
    ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(
      (error as NodeJS.ErrnoException)?.code || "",
    )
  )
    throw new Problem(
      422,
      "The agent workspace directory is missing or inaccessible. Restore it or choose an existing directory in a new conversation.",
    );
  throw error;
}

export function boundWorkspaceArgs(
  binding: Binding,
  agentId: string | null | undefined,
  ownerId: string,
) {
  if (!agentId || binding.worktree_agent_id !== agentId)
    throw new Problem(
      409,
      "Start a new conversation to use this agent's workspace. The old session and files are preserved.",
    );
  const source = binding.worktree_source ?? binding.project;
  return [
    source,
    source,
    {
      ownerId,
      agentId,
      environmentId: realpathSync(config.data),
      projectId: source,
    },
    {
      directory: binding.project,
      worktreeSource: binding.worktree_source ?? null,
    },
  ] as const;
}

export function boundWorkspace(
  binding: Binding,
  agentId: string | null | undefined,
  ownerId: string,
) {
  return prepareWorkspace(...boundWorkspaceArgs(binding, agentId, ownerId));
}
