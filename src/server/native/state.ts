import { NativeOutput } from "../native-output.js";

import { type Run } from "../queue.js";
import { type Adapter } from "../../adapters/types.js";
import { type Harness, type Request } from "../../protocol.js";
import { type PermissionMode } from "../../shared/permission-modes.js";
export const OWNER = "local-workspace";

export type Binding = {
  conversation_id: string;
  harness: Harness;
  native_id: string | null;
  project: string;
  // A bound agent with no worktree source uses its ordinary project directory.
  // The agent id pins both modes; a missing id identifies a legacy session.
  worktree_source?: string | null;
  worktree_agent_id?: string | null;
  model: string | null;
  effort?: string | null;
  permission_mode?: string | null;
  permission_base?: string | null;
  instructions: string;
  generation: string;
  state: string;
};

/** @internal Native session state, exposed for typed projection tests. */
export type Live = {
  adapter: Adapter;
  generation: string;
  binding: Binding;
  ready: Promise<void>;
  bootstrapRun: Run;
  run?: Run;
  /** The model the harness last reported for this session. */
  reportedModel?: string;
  items: NativeOutput;
  requests: Map<string, Request>;
  finish?: (state: string) => void;
  flush?: NodeJS.Timeout;
  idle?: NodeJS.Timeout;
  closed: boolean;
  /** Replacement must wait until the previous native process has exited. */
  disposal?: Promise<void>;
  cancelling: boolean;
  waiting: boolean;
  bridgeWaiting: number;
  /** The workspace approval level for this session's current turn. */
  permissionMode?: PermissionMode;
  /**
   * The native permission mode chosen for this session in Session settings.
   * It outranks the workspace level for Loop's automatic answers.
   */
  sessionMode?: string;
};
