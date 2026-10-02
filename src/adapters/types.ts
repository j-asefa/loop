import type {
  AdapterEvent,
  Billing,
  Capabilities,
  Harness,
} from "../protocol.js";
import type {
  ActivityCapabilities,
  CommandsData,
  SettingsData,
  SettingValue,
} from "../agent-activities.js";
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
  instructions?: string;
  probeOnly?: boolean;
  projectTrust?: boolean;
  workspaceTools?: { url: string; token: string };
  args?: string[];
};
export type NativeCommand = {
  name: string;
  token: string;
  kind: string;
  description: string;
  argumentHint?: string;
  disabledReason?: string;
  sourceInfo?: {
    source?: string;
    scope?: string;
    origin?: string;
    baseDir?: string;
    path?: string;
  };
};
export type Emit = (event: AdapterEvent) => void;
export interface Adapter {
  capabilities: Capabilities;
  models?: ModelOption[];
  defaultModelOption?: ModelOption;
  commands?: NativeCommand[];
  customizationInventory?: unknown;
  activityCapabilities?: ActivityCapabilities;
  settings?: SettingsData;
  commandCatalog?: CommandsData;
  setSetting?(
    id: string,
    value: SettingValue,
    revision: number,
  ): Promise<SettingsData>;
  start(): Promise<Billing>;
  prompt(text: string): Promise<void>;
  steer?(text: string): Promise<void>;
  cancel(): Promise<void>;
  answer(id: string, answer: Record<string, unknown>): Promise<void>;
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
