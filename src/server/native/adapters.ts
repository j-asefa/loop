import { Codex } from "../../adapters/codex.js";
import { Claude } from "../../adapters/claude.js";
import { Pi } from "../../adapters/pi.js";
import { OpenCode } from "../../adapters/opencode.js";
import { Gemini } from "../../adapters/gemini.js";
import { Muse } from "../../adapters/muse.js";
import { Grok } from "../../adapters/grok.js";
import { Acp } from "../../adapters/acp.js";
export const classes = {
  codex: Codex,
  claude: Claude,
  pi: Pi,
  opencode: OpenCode,
  acp: Acp,
  gemini: Gemini,
  muse: Muse,
  grok: Grok,
};

export const labels = {
  codex: "Codex",
  claude: "Claude Code",
  pi: "Pi",
  opencode: "OpenCode",
  acp: "ACP agent",
  gemini: "Gemini CLI",
  muse: "Muse Code",
  grok: "Grok Build",
};
