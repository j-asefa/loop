import { RuntimeFailure } from "./diagnostics.mjs";

// A background projection consumes supplied records, never a native workspace.
// These overrides belong to its ephemeral thread, not the account's saved config.
async function readProjectionConfig(rpc, cwd) {
  const { config } = await rpc.call("config/read", {
    includeLayers: false,
    ...(cwd ? { cwd } : {}),
  });
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new RuntimeFailure("Cannot verify the brief runtime configuration");
  if (
    ![undefined, null, "openai"].includes(config.model_provider) ||
    config.model_providers?.openai
  )
    throw new RuntimeFailure(
      "Brief generation requires the built-in ChatGPT subscription provider",
    );
  return config;
}

export async function projectionDefaultModel(rpc, cwd) {
  const config = await readProjectionConfig(rpc, cwd);
  if (typeof config.model === "string" && config.model) return config.model;
  const { data } = await rpc.call("model/list", { limit: 100 });
  const model = data?.find((model) => model.isDefault) ?? data?.[0];
  const name = model?.model || model?.id;
  if (typeof name !== "string" || !name)
    throw new RuntimeFailure(
      "Cannot resolve the native default model for this brief",
    );
  return name;
}

export async function projectionConfig(rpc, cwd) {
  const config = await readProjectionConfig(rpc, cwd);
  return {
    forced_login_method: "chatgpt",
    "features.shell_tool": false,
    "features.unified_exec": false,
    "features.multi_agent": false,
    "features.apps": false,
    "features.remote_plugin": false,
    "features.hooks": false,
    "features.memories": false,
    "features.goals": false,
    "features.code_mode.enabled": false,
    "tools.view_image": false,
    web_search: "disabled",
    project_doc_max_bytes: 0,
    notify: [],
    mcp_servers: Object.fromEntries(
      Object.keys(config.mcp_servers || {}).map((name) => [
        name,
        { enabled: false, required: false },
      ]),
    ),
    plugins: Object.fromEntries(
      Object.keys(config.plugins || {}).map((name) => [
        name,
        { enabled: false },
      ]),
    ),
  };
}

export const projectionRefusal = () => ({
  error: {
    code: -32601,
    message: "Native actions are disabled for this background projection.",
  },
});

export function assertProjectionThread(thread) {
  if (
    thread.modelProvider !== "openai" ||
    thread.approvalPolicy !== "never" ||
    thread.sandbox?.type !== "readOnly" ||
    thread.sandbox.networkAccess === true
  )
    throw new RuntimeFailure(
      "The subscription runtime did not confirm a read-only brief session",
    );
}

export const claudeProjectionArgs = [
  "--permission-mode",
  "dontAsk",
  "--tools",
  "",
  "--disallowedTools",
  "mcp__*",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--disable-slash-commands",
  "--setting-sources",
  "",
  "--settings",
  '{"disableAllHooks":true}',
];
