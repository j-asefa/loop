export type AuthProvider = {
  id: string;
  name: string;
  configured?: boolean;
  source?: "stored" | "environment" | "configuration" | "runtime" | "unknown";
  credentialType?: "api" | "oauth";
  removable?: boolean;
  methods: { id: string; label: string; type: "oauth" | "api" }[];
};
export type AuthPrompt = {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  options?: { id: string; label: string }[];
};
export const signInFailureCodes = ["gemini_google_sign_in_retired"] as const;
export type SignInFailureCode = (typeof signInFailureCodes)[number];
export const signInFailureMessages: Record<SignInFailureCode, string> = {
  gemini_google_sign_in_retired:
    "Google has retired personal-account sign-in for Gemini CLI, including Google AI Pro and Ultra. Use Antigravity for Google sign-in, or configure Gemini CLI with API credentials (separate billing). Signing in again with the same account will not fix this.",
};
export type SignIn = {
  id: string;
  commandId?: string;
  provider: string;
  method: string;
  state:
    "starting" | "waiting" | "complete" | "failed" | "cancelled" | "expired";
  expiresAt: number;
  failureCode?: SignInFailureCode;
  url?: string;
  code?: string;
  instructions?: string;
  prompt?: AuthPrompt;
};
export type NativeAuthView = { providers: AuthProvider[]; attempt?: SignIn };
