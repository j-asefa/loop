import type { ChatInput } from "../src/server/providers.js";

// Native processes receive JSON, not server-side cancellation or inbox objects.
// Cancellation is supplied separately by the process that owns the operation.
export type RuntimeInput = Omit<
  ChatInput,
  "signal" | "steering" | "instructions"
> & {
  instructions?: string;
  controlId?: string;
  nativeTools?: boolean;
};
export type SessionRequest = {
  provider?: string;
  githubToken?: string;
  workspaceKey?: string;
} & (
  | { action: "turn"; input: RuntimeInput }
  | {
      action: "login" | "logout" | "status" | "capabilities" | "project-brief";
      input?: RuntimeInput;
    }
);
export type Steering = (text: string) => Promise<void>;
