/** Named browser migration exceptions; no arbitrary string path is accepted. */
type Path =
  | `/agent-sources`
  | `/agents/${string}`
  | `/artifacts/${string}`
  | `/artifacts/${string}/app`
  | `/artifacts/${string}/move`
  | `/artifacts/${string}/refresh`
  | `/artifacts/${string}/tool-call`
  | `/conversations/${string}/memory`
  | `/mcp`
  | `/mcp-sharing`
  | `/mcp/${string}`
  | `/mcp/${string}/test`
  | `/mcp/catalog`
  | `/mcp/catalog/${string}/install`
  | `/mcp/install`
  | `/mcp/native-candidates`
  | `/mcp/native-candidates/${string}/import`
  | `/mcp/preferences`
  | `/me/profile`
  | `/memory`
  | `/memory/notes`
  | `/memory/notes/${string}`
  | `/memory/policy`
  | `/memory/sources/${string}`
  | `/results/${string}`
  | `/routing/preview`
  | `/runs/${string}/activities`
  | `/runs/${string}/memory`
  | `/runs/${string}/steps`
  | `/runs/${string}/withdraw`
  | `/scheduled-sends`
  | `/scheduled-sends/${string}`
  | `/share/preview`
  | `/subscriptions/${string}/native-auth`
  | `/subscriptions/${string}/native-auth/cancel`
  | `/subscriptions/${string}/native-auth/input`
  | `/subscriptions/${string}/native-auth/providers`
  | `/subscriptions/${string}/native-auth/start`
  | `/subscriptions/${string}/native-auth/status`
  | `/subscriptions/${string}/upgrade`
  | `/subscriptions/${string}/upgrade/recover`
  | `/v1/cards`
  | `/v1/cards/${string}`
  | `/v1/cards/changes`
  | `/workflows`
  | `/workflows/${string}`
  | `/workflows/${string}/run`
  | `/workflows/validate`
  | `/workspace/devices`
  | `/workspace/revoke`;
export type LegacyClientPath = Path | `${Path}?${string}`;
export type LegacyFetchPath =
  `/api${LegacyClientPath}` | `/api/agent-sources/${string}${LegacyClientPath}`;
