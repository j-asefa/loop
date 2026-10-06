import { profileCapabilities, type Capabilities } from "../shared/capabilities";
import {
  executionSourceId,
  returnToLocalSource,
  sourceApiPath,
} from "./sourceRouting";
export let capabilities: Capabilities = profileCapabilities("server");
export async function loadCapabilities() {
  const response = await fetch(sourceApiPath("/api/capabilities"), {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (response.status === 401 && executionSourceId()) {
    const local = await fetch("/api/capabilities", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (local.ok) {
      capabilities = await local.json();
      returnToLocalSource();
      return;
    }
  }
  if (!response.ok && executionSourceId()) {
    returnToLocalSource();
    return;
  }
  if (!response.ok) throw new Error("Cannot load workspace capabilities");
  capabilities = await response.json();
}
