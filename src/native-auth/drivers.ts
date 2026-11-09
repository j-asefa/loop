import { RuntimeHarness } from "../shared/harnesses.js";
import type { AuthDriver, AuthOptions } from "../server/native-auth.js";
import { cliDriver } from "./cli.js";
import { piDriver } from "./pi.js";
import { openCodeDriver } from "./opencode.js";
import { antigravityDriver } from "./antigravity.js";
import { museDriver } from "./muse.js";
const drivers = {
  codex: cliDriver,
  claude: cliDriver,
  grok: cliDriver,
  pi: piDriver,
  opencode: openCodeDriver,
  muse: museDriver,
  antigravity: antigravityDriver,
} satisfies Record<
  RuntimeHarness,
  (options: AuthOptions) => AuthDriver | Promise<AuthDriver>
>;
export async function createAuthDriver(
  options: AuthOptions,
): Promise<AuthDriver> {
  const name = RuntimeHarness.safeParse(options.name);
  if (!name.success) throw new Error("Unsupported sign-in harness");
  return drivers[name.data](options);
}
