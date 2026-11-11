import {
  workspaceDataDirectory,
  workspaceDatabasePath,
} from "./data-directory.js";
import { mkdirSync } from "node:fs";
import { assertPreviewDataDir } from "../preview-context.js";
const data = workspaceDataDirectory(process.env.LOOP_DATA_DIR);
let workspaceUrl = process.env.LOOP_URL || "http://localhost:3000";
export function setWorkspaceUrl(url: string) {
  workspaceUrl = url;
}
export const config = {
  get url() {
    return workspaceUrl;
  },
  get embeddingModel() {
    return process.env.LOOP_EMBEDDING_MODEL || "text-embedding-3-small";
  },
  get encryptionKey() {
    return process.env.LOOP_ENCRYPTION_KEY;
  },
  get environment() {
    return process.env.NODE_ENV;
  },
  port: Number(process.env.PORT || 3000),
  changePollMs: Number(process.env.LOOP_CHANGE_POLL_MS || 250),
  data,
  database: workspaceDatabasePath(data),
};
assertPreviewDataDir(config.data);
mkdirSync(config.data, { recursive: true, mode: 0o700 });
