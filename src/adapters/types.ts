import type { WorkspaceTools } from "../shared/workspace-tools.js";
import type { NativeCommand } from "../shared/native-commands.js";
export type { NativeCommand } from "../shared/native-commands.js";
import type { AdapterEvent } from "./events.js";
import type { Billing, Capabilities, Harness } from "../shared/protocol.js";
import type {
  ActivityCapabilities,
  CommandsData,
  SettingsData,
  SettingValue,
} from "../shared/agent-activities.js";
import type { ModelOption } from "../shared/models.js";
export type Options = {
  harness: Harness;
  executable: string;
  project: string;
  billing: "subscription" | "existing";
  resume?: string;
  version: string;
  model?: string;
  effort?: string;
  /** Native launch permission mode; only set for harnesses that accept one. */
  permissionMode?: string;
  instructions?: string;
  probeOnly?: boolean;
  projectTrust?: boolean;
  workspaceTools?: WorkspaceTools;
  args?: string[];
};
export type Emit = (event: AdapterEvent) => void;
// Live input that was certainly not handed to the harness (no turn to take
// it, or the harness gave it back). Unlike other failures it may be retried.
export class NotDelivered extends Error {}
export interface Adapter {
  capabilities: Capabilities;
  /** False when the native process cannot accept another explicit turn. */
  readonly reusable?: boolean;
  models?: ModelOption[];
  defaultModelOption?: ModelOption;
  commands?: NativeCommand[];
  customizationInventory?: unknown;
  activityCapabilities?: ActivityCapabilities;
  settings?: SettingsData;
  /** Read the loaded catalog without native IO or publication. */
  commandCatalog?: CommandsData;
  /** Explicitly request throttled catalog rediscovery for an active session. */
  refreshCommandCatalog?(): void;
  /** Call beforeApply after validation, immediately before changing state or
   * handing the setting to the harness. Preflight rejection must not call it;
   * a failure after this point can represent an uncertain effect. */
  setSetting?(
    id: string,
    value: SettingValue,
    revision: number,
    beforeApply?: () => void,
  ): Promise<SettingsData>;
  start(): Promise<Billing>;
  /** Recheck immediately before each native dispatch, after asynchronous
   * preparation or queueing. A thrown guard must prevent that dispatch. */
  prompt(text: string, beforeDispatch?: () => void): Promise<void>;
  steer?(text: string, beforeDispatch?: () => void): Promise<void>;
  cancel(): Promise<void>;
  answer(
    id: string,
    answer: Record<string, unknown>,
    beforeDispatch?: () => void,
  ): Promise<void>;
  dispose(): Promise<void>;
}
export const capabilities: Capabilities = {
  approvals: true,
  questions: true,
  resume: true,
  liveAttach: false,
  terminal: false,
};
export function conflict(mode: Options["billing"], keys: string[]) {
  if (mode === "subscription" && keys.some((k) => !!process.env[k])) {
    throw new Error(
      `Subscription mode conflicts with ${keys.filter((k) => !!process.env[k]).join(", ")}. Resolve in your native harness environment, or explicitly use --billing existing to retain that configuration. Loop did not change it.`,
    );
  }
}
