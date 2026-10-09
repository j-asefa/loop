import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export function inspectOpencodeNativeAuth(source: NodeJS.ProcessEnv) {
  if (
    !source.HOME ||
    !isAbsolute(source.HOME) ||
    (source.XDG_DATA_HOME && !isAbsolute(source.XDG_DATA_HOME))
  )
    throw new Error("OpenCode native home must be absolute");
  let authenticated = false;
  try {
    const store = join(
      source.XDG_DATA_HOME || join(source.HOME, ".local", "share"),
      "opencode",
      "auth.json",
    );
    const auth = JSON.parse(readFileSync(store, "utf8")).openai;
    authenticated =
      auth?.type === "oauth" &&
      typeof auth.refresh === "string" &&
      auth.refresh.length > 0 &&
      typeof auth.access === "string" &&
      auth.access.length > 0 &&
      Number.isFinite(auth.expires);
  } catch {
    // Missing, malformed and unreadable stores cannot establish native sign-in.
  }
  return {
    authenticated,
    authMethod: "chatgpt",
    managed: true,
    checkedAt: Date.now(),
    models: [],
  };
}

export function opencodeSubscriptionEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!source.HOME || !isAbsolute(source.HOME))
    throw new Error("OpenCode credential home is required");
  // An allow-list also excludes future provider credentials and injected code.
  // Preserve the runner's native homes: never copy tokens to a Loop store.
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "SSH_AUTH_SOCK",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
  ]) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  for (const name of [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
  ])
    if (env[name] && !isAbsolute(env[name]!))
      throw new Error("OpenCode native home must be absolute");
  if (!inspectOpencodeNativeAuth(env).authenticated)
    throw new Error("OpenCode requires native OpenAI OAuth sign-in");
  return {
    ...env,
    LOOP_OPENCODE_SUBSCRIPTION_ONLY: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_EXPERIMENTAL_NATIVE_LLM: "0",
    OPENCODE_EXPERIMENTAL_WEBSOCKETS: "0",
    // Built-in OAuth rewrites Responses calls to ChatGPT. If OAuth disappears,
    // ordinary fetch cannot send a billable request through this scheme.
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      enabled_providers: ["openai"],
      provider: {
        openai: { options: { baseURL: "loop-subscription-only://openai/v1" } },
      },
    }),
  };
}

/** Reject configuration paths which can override the managed billing boundary. */
export function validateManagedOpencodeConfig(value: unknown): void {
  const fail = () => {
    throw new Error("OpenCode effective subscription configuration rejected");
  };
  const object = (v: unknown): v is Record<string, any> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (!object(value)) return fail();
  const config = value;
  if (
    !Array.isArray(config.enabled_providers) ||
    config.enabled_providers.length !== 1 ||
    config.enabled_providers[0] !== "openai"
  )
    return fail();
  if (
    config.plugin !== undefined &&
    (!Array.isArray(config.plugin) || config.plugin.length)
  )
    return fail();
  if (
    !object(config.provider) ||
    Object.keys(config.provider).some((key) => key !== "openai")
  )
    return fail();
  const provider = config.provider.openai;
  if (
    !object(provider) ||
    Object.keys(provider).some((key) => key !== "options")
  )
    return fail();
  if (
    !object(provider.options) ||
    Object.keys(provider.options).length !== 1 ||
    provider.options.baseURL !== "loop-subscription-only://openai/v1"
  )
    return fail();
  const model = (v: unknown) =>
    v === undefined || (typeof v === "string" && /^openai\/[^/\s]+$/.test(v));
  if (!model(config.model) || !model(config.small_model)) return fail();
  for (const field of ["agent", "mode", "command"]) {
    if (config[field] === undefined) continue;
    if (!object(config[field])) return fail();
    for (const entry of Object.values(config[field])) {
      if (!object(entry) || !model(entry.model)) return fail();
    }
  }
}

/** Validate resolved SDK routing as well as user-facing configuration. */
export function validateManagedOpencodeProviders(value: unknown): void {
  const fail = () => {
    throw new Error("OpenCode effective subscription model routing rejected");
  };
  const object = (v: unknown): v is Record<string, any> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (
    !object(value) ||
    !Array.isArray(value.providers) ||
    value.providers.length !== 1
  )
    return fail();
  const provider = value.providers[0];
  if (
    !object(provider) ||
    provider.id !== "openai" ||
    !object(provider.options)
  )
    return fail();
  // These are the serializable options emitted by the pinned native OAuth loader.
  // A function-valued fetch hook is not visible over HTTP; this is not proof of
  // that hook's presence. The forced sink remains necessary if OAuth disappears.
  const options = provider.options;
  if (
    options.baseURL !== "loop-subscription-only://openai/v1" ||
    options.apiKey !== "opencode-oauth-dummy-key" ||
    Object.keys(options).some(
      (key) => !["baseURL", "apiKey", "headerTimeout"].includes(key),
    ) ||
    (options.headerTimeout !== undefined && options.headerTimeout !== 300000) ||
    provider.key !== undefined
  )
    return fail();
  if (!object(provider.models) || Object.keys(provider.models).length === 0)
    return fail();
  for (const [id, model] of Object.entries(provider.models)) {
    if (
      !object(model) ||
      model.id !== id ||
      !/^[a-zA-Z0-9._-]+$/.test(id) ||
      model.providerID !== "openai" ||
      !object(model.api) ||
      model.api.npm !== "@ai-sdk/openai" ||
      typeof model.api.id !== "string" ||
      !/^[a-zA-Z0-9._-]+$/.test(model.api.id) ||
      !object(model.headers) ||
      Object.keys(model.headers).length !== 0
    )
      return fail();
  }
  if (
    !object(value.default) ||
    Object.keys(value.default).some((key) => key !== "openai") ||
    typeof value.default.openai !== "string" ||
    !Object.hasOwn(provider.models, value.default.openai)
  )
    return fail();
}

/** Project only model identity/display metadata after validating the entire route.
 * Provider options and native credential material must never leave the runner.
 */
export function managedOpencodeModels(value: unknown) {
  validateManagedOpencodeProviders(value);
  const catalog = value as {
    providers: { models: Record<string, { name?: unknown }> }[];
    default: { openai: string };
  };
  return Object.entries(catalog.providers[0].models).map(([id, model]) => ({
    id: `openai/${id}`,
    name:
      typeof model.name === "string" && model.name.trim()
        ? model.name.trim().slice(0, 200)
        : id,
    isDefault: id === catalog.default.openai,
    capabilities: "Native OpenCode model; availability depends on your account",
  }));
}

/** The OAuth rewrite and fallback sink were audited only for this release.
 * This is a compatibility gate, not an installer preference. New versions need
 * a renewed routing/configuration audit before being admitted here.
 */
export function validateManagedOpencodeVersion(value: unknown): void {
  const health = value as {
    healthy?: unknown;
    version?: unknown;
    loopExecutionGuard?: { revision?: unknown; active?: unknown };
  } | null;
  if (
    !health ||
    health.healthy !== true ||
    health.version !== "1.18.32" ||
    health.loopExecutionGuard?.revision !== "loop-subscription-v1" ||
    health.loopExecutionGuard?.active !== true
  )
    throw new Error(
      "OpenCode subscription guard requires audited version 1.18.32 with active execution guard",
    );
}

export async function inspectOpencodeCatalog(
  baseUrl: string,
  directory: string,
  headers: Record<string, string>,
): Promise<ReturnType<typeof managedOpencodeModels>> {
  if (!headers.Authorization)
    throw new Error("OpenCode authentication required");
  const url = new URL(baseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("OpenCode effective configuration endpoint rejected");
  url.pathname = "/global/health";
  url.searchParams.set("directory", directory);
  try {
    const response = await fetch(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Unavailable");
    validateManagedOpencodeVersion(await response.json());
    url.pathname = "/config";
    const config = await fetch(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!config.ok) throw new Error("Unavailable");
    validateManagedOpencodeConfig(await config.json());
    url.pathname = "/config/providers";
    const providers = await fetch(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!providers.ok) throw new Error("Unavailable");
    return managedOpencodeModels(await providers.json());
  } catch {
    // Native responses may contain secrets; never surface their body or error.
    throw new Error(
      "OpenCode effective subscription configuration could not be verified",
    );
  }
}

/** Pi uses native stored provider settings; Loop makes no subscription claim. */
export function piExistingEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!source.HOME || !isAbsolute(source.HOME))
    throw new Error("Pi credential home is required");
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "SSH_AUTH_SOCK",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "PI_CODING_AGENT_DIR",
  ])
    if (source[key] !== undefined) env[key] = source[key];
  for (const key of [
    "PI_CODING_AGENT_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
  ])
    if (env[key] && !isAbsolute(env[key]!))
      throw new Error("Pi native home must be absolute");
  return env;
}
