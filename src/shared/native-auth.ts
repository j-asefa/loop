import type { z } from "zod";
import type { NativeProvider } from "./native-providers.js";

export type AuthProvider = z.input<typeof NativeProvider>;
export type AuthPrompt = {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  options?: { id: string; label: string }[];
};
export type SignIn = {
  id: string;
  commandId: string;
  provider: string;
  method: string;
  state:
    "starting" | "waiting" | "complete" | "failed" | "cancelled" | "expired";
  expiresAt: number;
  url?: string;
  code?: string;
  instructions?: string;
  prompt?: AuthPrompt;
};
export type NativeAuthView = { providers: AuthProvider[]; attempt?: SignIn };
