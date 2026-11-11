import { join, resolve } from "node:path";

export function workspaceDataDirectory(input: string | undefined) {
  return resolve(input || "./data");
}

export function workspaceDatabasePath(data: string) {
  return join(data, "loop.db");
}
