/**
 * The runner's subscription sign-in must not inherit an inline auth store,
 * alternate provider endpoint, or replacement OAuth plugin from the host.
 * HOME and XDG paths deliberately remain unchanged: credentials belong to
 * OpenCode's native store on this runner, including during token refresh.
 * This is a sign-in policy, not proof that model execution is subscription-only.
 */
export function opencodeSignInEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (
      /^(OPENCODE_|OPENAI_|ANTHROPIC_|AZURE_|AWS_)/i.test(name) ||
      /(?:^|_)(?:API_KEY|BASE_URL)$/i.test(name) ||
      /^(NODE_OPTIONS|BUN_OPTIONS|CLAUDE_CODE_OAUTH_TOKEN)$/i.test(name)
    )
      delete env[name];
  }
  return {
    ...env,
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  };
}
