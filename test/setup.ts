import { afterAll } from "vitest";
import { createTestWorkspace } from "./helpers/test-workspace.js";

const previous = {
  LOOP_DATA_DIR: process.env.LOOP_DATA_DIR,
  LOOP_ENCRYPTION_KEY: process.env.LOOP_ENCRYPTION_KEY,
};
const workspace = createTestWorkspace();
process.env.LOOP_DATA_DIR = workspace.directory;
process.env.LOOP_ENCRYPTION_KEY = workspace.encryptionKey;

// Setup hooks register first. Vitest's stack order runs this after file-owned
// servers and databases close; removing the workspace must not own their stop.
afterAll(() => {
  try {
    workspace.close();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
