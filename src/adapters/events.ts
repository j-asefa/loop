import type {
  ActivityEvent,
  ActivityCapabilities,
} from "../shared/agent-activities.js";
import type { Status, Billing, Item, Request } from "../shared/protocol.js";

export type AdapterEvent =
  // NativeSessions owns adapter ingress and persists the display projection.
  | ActivityEvent
  | { type: "usage"; usage: { input_tokens: number; output_tokens: number } }
  | { type: "activity_capabilities"; capabilities: ActivityCapabilities }
  | { type: "status"; status: Status; detail?: string; recoverable?: boolean }
  | { type: "metadata"; nativeSession: string; billing?: Billing }
  | { type: "item"; item: Item }
  | { type: "delta"; id: string; text: string }
  | { type: "request"; request: Request }
  | { type: "resolved"; id: string }
  | { type: "error"; message: string };
