export type Provider =
  "openai" | "anthropic" | "codex" | "pi" | "opencode" | "gemini" | "acp";
export type Agent = {
  id: string;
  owner_id: string;
  name: string;
  provider: Provider;
  connection_id: string | null;
  model: string;
  effort?: string | null;
  instructions: string;
  folder_id?: string | null;
  origin: string;
  retired_at?: number | null;
  created_at: number;
};
export type CreatedAgent = Agent & {
  initialRun?: { id: string; conversation_id: string | null };
};
export type Connection = {
  id: string;
  owner_id: string;
  provider: Provider;
  label: string;
  secret: string;
  status: string;
  models: string;
  metadata: string;
  created_at: number;
};
export type Message = {
  id: string;
  owner_id: string;
  conversation_id: string;
  run_id: string | null;
  run_state?: string | null;
  run_error?: string | null;
  /** JSON checkout summary Loop observed for the run, when it has one. */
  run_checkout?: string | null;
  /** JSON list of verification commands Loop observed for the run. */
  run_verification?: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: string;
  created_at: number;
};
export type Artifact = {
  id: string;
  owner_id: string;
  agent_id: string | null;
  conversation_id: string | null;
  run_id: string | null;
  run_state?: string | null;
  run_error?: string | null;
  title: string;
  kind: string;
  content: string;
  metadata: string;
  folder_id: string | null;
  pinned: number;
  archived: number;
  feed_hidden?: number;
  version: number;
  created_at: number;
  updated_at: number;
  name?: string;
  provider?: Provider;
};
export type Folder = {
  path?: string;
  id: string;
  name: string;
  parent_id: string | null;
  kind: "folder" | "project";
};
export type Run = {
  id: string;
  agent_id: string | null;
  conversation_id: string | null;
  input: string;
  state: string;
  payload: string;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  preview_artifact?: Artifact | null;
};
export type Team = {
  id: string;
  name: string;
  manager_id: string;
  conversation_id: string | null;
  members: string[];
  preset_id?: string | null;
  preset_version?: number | null;
  folder_id?: string | null;
  // Message threads between its agents that hit a limit and await Resume.
  paused_threads?: number;
};
