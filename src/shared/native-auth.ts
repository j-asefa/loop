export type AuthProvider = {
  id: string;
  name: string;
  configured?: boolean;
  methods: { id: string; label: string; type: "oauth" | "api" }[];
};
export type AuthPrompt = {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  options?: { id: string; label: string }[];
};
export type SignIn = {
  id: string;
  commandId?: string;
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
