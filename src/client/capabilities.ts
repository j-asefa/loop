import { profileCapabilities, type Capabilities } from "../shared/capabilities";
export let capabilities: Capabilities = profileCapabilities("server");
export async function loadCapabilities() {
  const response = await fetch("/api/capabilities", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("Cannot load workspace capabilities");
  capabilities = await response.json();
}
