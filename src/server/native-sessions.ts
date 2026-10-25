// Stable worker/HTTP import boundary. The supervisor owns each instance's live sessions.
import { NativeSessions } from "./native/supervisor.js";
export { NativeSessions };
export { OWNER } from "./native/state.js";
export type { Live } from "./native/state.js";
export { prepareImportedWorkspace } from "./native/workspace.js";

export const nativeSessions = new NativeSessions();
