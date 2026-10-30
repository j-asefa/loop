import type { Agent, Team } from "./types.js";

export const MAX_DEFINITION_BYTES = 128 * 1024;
export type DefinitionRole = {
  name: string;
  description: string;
  instructions: string;
  model?: string;
  effort?: string | null;
};
export type DefinitionSpec =
  | (DefinitionRole & { kind: "agent" })
  | {
      kind: "team";
      name: string;
      description: string;
      manager: DefinitionRole;
      members: DefinitionRole[];
    };
export type DefinitionSummary = {
  id: string;
  kind: "agent" | "team";
  name: string;
  description: string;
  version: number;
  created_at: number;
  updated_at: number;
};
export type AgentDefinition = DefinitionSummary & {
  markdown: string;
  spec: DefinitionSpec;
};
export type DefinitionCreation = { agent?: Agent; team?: Team };

export const DEFINITION_EXAMPLES = {
  agent: `---
name: code-reviewer
description: Reviews changes for correctness and missing tests.
---

You are a code reviewer. Read the relevant code, identify concrete bugs,
and explain each finding with file references. Do not edit files.
`,
  team: `---
kind: team
name: Feature team
description: Implement and review a change.
manager:
  name: feature-lead
  instructions: |
    Own the implementation. Delegate an independent review with loop55_delegate,
    address confirmed findings, and report changes and checks to the user.
members:
  - name: feature-reviewer
    instructions: |
      Review the implementation for correctness and missing tests.
      Return concrete findings with file references. Leave edits to the lead.
---

Follow the project's conventions. Distinguish verified results from assumptions.
`,
};
