import type {
  AdapterEvent,
  Billing,
  Capabilities,
  Harness,
} from "../protocol.js";
export type Options = {
  harness: Harness;
  executable: string;
  project: string;
  billing: "subscription" | "existing";
  resume?: string;
  version: string;
  model?: string;
  instructions?: string;
  probeOnly?: boolean;
  workspaceTools?: { url: string; token: string };
};
export type NativeCommand = {
  name: string;
  token: string;
  kind: string;
  description: string;
  argumentHint?: string;
  disabledReason?: string;
};
export type Emit = (event: AdapterEvent) => void;
export interface Adapter {
  capabilities: Capabilities;
  models?: { id: string; name: string }[];
  commands?: NativeCommand[];
  start(): Promise<Billing>;
  prompt(text: string): Promise<void>;
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
