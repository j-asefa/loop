import type { RuntimeSetupState } from "./shared/runtime-setup.js";

// The companion server and launcher share a process. This state describes only
// its startup; it is not proof of runner health or provider authentication.
let state: RuntimeSetupState = "idle";
export function setRuntimeSetupState(next: RuntimeSetupState) {
  state = next;
}
export function runtimeSetupState(): RuntimeSetupState {
  return state;
}
