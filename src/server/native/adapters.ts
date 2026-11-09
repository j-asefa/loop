import { harnesses, type Harness } from "../../shared/harnesses.js";
import type { Adapter, Options, Emit } from "../../adapters/types.js";
import { Codex } from "../../adapters/codex.js";
import { Claude } from "../../adapters/claude.js";
import { Pi } from "../../adapters/pi.js";
import { OpenCode } from "../../adapters/opencode.js";
import { Antigravity } from "../../adapters/antigravity.js";
import { Muse } from "../../adapters/muse.js";
import { Grok } from "../../adapters/grok.js";
import { Acp } from "../../adapters/acp.js";
export const classes = {
  codex: Codex,
  claude: Claude,
  pi: Pi,
  opencode: OpenCode,
  acp: Acp,
  antigravity: Antigravity,
  muse: Muse,
  grok: Grok,
} satisfies Record<
  Harness,
  {
    new (options: Options, emit: Emit): Adapter;
    readonly startupSteps: Readonly<Record<string, string>>;
  }
>;

export const labels = Object.fromEntries(
  Object.entries(harnesses).map(([name, descriptor]) => [
    name,
    descriptor.label,
  ]),
) as Record<Harness, string>;
