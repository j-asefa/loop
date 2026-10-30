import "../../runtime/environment.mjs";
import { profileCapabilities } from "../shared/capabilities.js";
const value = process.env.LOOP55_PROFILE || "server";
if (value !== "server" && value !== "companion")
  throw new Error("LOOP55_PROFILE must be server or companion");
export const companionMode = value === "companion";
export const capabilities = profileCapabilities(value);
