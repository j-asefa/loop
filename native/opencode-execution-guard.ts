import "../deployment/environment.mjs";
/** Copied into the pinned OpenCode build by apply-opencode-patch.mjs.
 * The switch is captured once, before project/configuration loading. It is not
 * a native configuration option and cannot be changed by a config reload.
 */
const required = process.env.LOOP55_OPENCODE_SUBSCRIPTION_ONLY === "1";
export function executionGuardStatus() {
  return { revision: "loop55-subscription-v1", active: required };
}
const sink = "loop55-subscription-only://openai/v1";
const rejected = () => {
  throw new Error("Loop55 OpenCode subscription execution policy rejected");
};
const record = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function guardRuntime(flags: {
  pure: boolean;
  disableDefaultPlugins: boolean;
  experimentalNativeLlm: boolean;
  experimentalWebSockets: boolean;
}) {
  if (!required) return;
  if (
    !flags.pure ||
    flags.disableDefaultPlugins ||
    flags.experimentalNativeLlm ||
    flags.experimentalWebSockets
  )
    rejected();
}

/** Runs before SDK lookup/construction, including after native cache reloads.
 * Existing cached SDKs were constructed through this same boundary. Keep the
 * native OAuth fetch hook; never substitute Loop55-owned credential handling.
 */
export function guardSDK(model: unknown, provider: unknown, options: unknown) {
  if (!required) return;
  if (!record(model) || !record(provider) || !record(options))
    return rejected();
  if (
    model.providerID !== "openai" ||
    provider.id !== "openai" ||
    provider.key !== undefined ||
    !record(model.api) ||
    model.api.npm !== "@ai-sdk/openai" ||
    typeof model.api.id !== "string" ||
    !/^[a-zA-Z0-9._-]+$/.test(model.api.id) ||
    !record(model.headers) ||
    Object.keys(model.headers).length !== 0 ||
    options.baseURL !== sink ||
    options.apiKey !== "opencode-oauth-dummy-key" ||
    typeof options.fetch !== "function" ||
    Object.keys(options).some(
      (key) =>
        !["baseURL", "apiKey", "fetch", "headerTimeout", "headers"].includes(
          key,
        ),
    ) ||
    (options.headerTimeout !== undefined && options.headerTimeout !== 300000) ||
    (options.headers !== undefined &&
      (!record(options.headers) || Object.keys(options.headers).length !== 0))
  )
    rejected();
}

/** Called inside the built-in OAuth fetch closure before its fallback branch.
 * Native refresh and endpoint rewriting remain owned by OpenCode.
 */
export function guardOAuth(auth: unknown, input: RequestInfo | URL) {
  if (!required) return;
  if (!record(auth) || auth.type !== "oauth") return rejected();
  let url: URL;
  try {
    url = new URL(
      input instanceof URL
        ? input.href
        : typeof input === "string"
          ? input
          : input.url,
    );
  } catch {
    return rejected();
  }
  if (url.href !== sink + "/responses") rejected();
}
