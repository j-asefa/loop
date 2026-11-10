import type { AuthPrompt, AuthProvider } from "../shared/native-auth.js";

export type AuthOptions = {
  name: string;
  executable: string;
  project: string;
  /** Complete runner environment; never merge with the host when supplied. */
  env?: NodeJS.ProcessEnv;
};
export type AuthInteraction = {
  signal: AbortSignal;
  link(url: string, code?: string, instructions?: string): void;
  prompt(prompt: Omit<AuthPrompt, "id">, signal?: AbortSignal): Promise<string>;
};
export type AuthDriver = {
  readonly dead?: boolean;
  providers(): Promise<AuthProvider[]>;
  /** Optional prompt-free native model catalog; validated by the runner. */
  models?(): Promise<unknown>;
  /** Remove a provider credential through its native store API. */
  logout?(provider: string): Promise<void>;
  login(
    provider: string,
    method: string,
    interaction: AuthInteraction,
  ): Promise<void>;
  dispose(): Promise<void>;
};
