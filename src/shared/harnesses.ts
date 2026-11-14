import { z } from "zod";

export const apiProviders = ["openai", "anthropic"] as const;
type ApiProvider = (typeof apiProviders)[number];
export type CliSignIn = {
  provider: { id: string; name: string };
  methods: readonly {
    id: string;
    type: "oauth";
    label: string;
    args: readonly string[];
  }[];
  defaultArgs: readonly string[];
  response: { kind: "device-code" } | { kind: "manual-code"; prompt: string };
  domains: readonly { name: string; subdomains: boolean }[];
};
type HarnessDescriptor<H extends string> = {
  label: string;
  executable: string | null;
  minimumVersion: string | null;
  installUrl: string | null;
  runtime: boolean;
  billing: {
    default: "existing" | "subscription";
    subscription: boolean;
    cliConsent: boolean;
  };
  upgrade: {
    package: string | null;
    brew: readonly string[];
    selfUpdating: string | null;
  };
  environment: Readonly<Record<string, string>>;
  managed: boolean;
  workspaceTools: boolean;
  agentMail: boolean;
  midTurn: "steer" | "queue";
  // A native provider is its harness identity or an existing API provider.
  provider: H | ApiProvider;
  activityTransport: "native" | "acp";
  launchPermissionMode: boolean;
  cliSignIn: CliSignIn | null;
  importWorktree: boolean;
  history: string;
};

// Version floors admit newer stable releases; adapters still verify their live
// protocol and billing contract before dispatch. These are not release pins.
const descriptors = {
  codex: {
    label: "Codex",
    executable: "codex",
    minimumVersion: "0.157.0",
    installUrl: "https://developers.openai.com/codex/cli",
    runtime: true,
    billing: {
      default: "subscription",
      subscription: true,
      cliConsent: false,
    },
    upgrade: {
      package: "@openai/codex",
      brew: ["codex"],
      selfUpdating: null,
    },
    environment: {},
    managed: false,
    workspaceTools: true,
    agentMail: true,
    midTurn: "steer",
    provider: "codex",
    activityTransport: "native",
    launchPermissionMode: false,
    cliSignIn: {
      provider: { id: "openai", name: "ChatGPT" },
      methods: [
        {
          id: "oauth",
          type: "oauth",
          label: "Sign in with ChatGPT",
          args: ["login", "--device-auth"],
        },
      ],
      defaultArgs: ["login", "--device-auth"],
      response: { kind: "device-code" },
      domains: [
        { name: "openai.com", subdomains: true },
        { name: "chatgpt.com", subdomains: true },
      ],
    },
    importWorktree: true,
    history: "native read/list/fork",
  },
  claude: {
    label: "Claude Code",
    executable: "claude",
    minimumVersion: "2.1.237",
    installUrl: "https://code.claude.com/docs/en/setup",
    runtime: true,
    billing: {
      default: "subscription",
      subscription: true,
      cliConsent: false,
    },
    upgrade: {
      package: "@anthropic-ai/claude-code",
      brew: ["claude-code", "claude-code@latest"],
      selfUpdating: null,
    },
    environment: {},
    managed: false,
    workspaceTools: true,
    agentMail: true,
    midTurn: "steer",
    provider: "anthropic",
    activityTransport: "native",
    launchPermissionMode: true,
    cliSignIn: {
      provider: { id: "anthropic", name: "Claude" },
      methods: [
        {
          id: "oauth",
          type: "oauth",
          label: "Sign in with Claude",
          args: ["auth", "login", "--claudeai"],
        },
        {
          id: "console",
          type: "oauth",
          label: "Anthropic Console (API billing)",
          args: ["auth", "login", "--console"],
        },
      ],
      defaultArgs: ["auth", "login", "--claudeai"],
      response: {
        kind: "manual-code",
        prompt: "Paste the verification code from Claude",
      },
      domains: [
        { name: "anthropic.com", subdomains: true },
        { name: "claude.ai", subdomains: true },
        { name: "claude.com", subdomains: true },
      ],
    },
    importWorktree: false,
    history: "Loop-managed history; native resume",
  },
  pi: {
    label: "Pi",
    executable: "pi",
    minimumVersion: "0.87.1",
    installUrl: "https://github.com/earendil-works/pi",
    runtime: true,
    billing: {
      default: "existing",
      subscription: true,
      cliConsent: false,
    },
    upgrade: {
      package: "@earendil-works/pi-coding-agent",
      brew: ["pi"],
      selfUpdating: null,
    },
    environment: {},
    managed: true,
    workspaceTools: true,
    agentMail: true,
    midTurn: "steer",
    provider: "pi",
    activityTransport: "native",
    launchPermissionMode: false,
    cliSignIn: null,
    importWorktree: false,
    history: "Loop-managed history; native resume",
  },
  opencode: {
    label: "OpenCode",
    executable: "opencode",
    minimumVersion: "1.18.32",
    installUrl: "https://opencode.ai/docs",
    runtime: true,
    billing: {
      default: "existing",
      subscription: false,
      cliConsent: true,
    },
    upgrade: {
      package: "opencode-ai",
      brew: ["opencode"],
      selfUpdating: null,
    },
    environment: {},
    managed: true,
    workspaceTools: true,
    agentMail: true,
    midTurn: "queue",
    provider: "opencode",
    activityTransport: "native",
    launchPermissionMode: false,
    cliSignIn: null,
    importWorktree: false,
    history: "Loop-managed history; native resume",
  },
  antigravity: {
    label: "Antigravity",
    executable: "agy",
    // Public stream-json, exact conversation resume and literal prompts.
    minimumVersion: "1.4.9",
    installUrl: "https://antigravity.google/docs/getting-started?tab=cli",
    runtime: true,
    billing: {
      default: "existing",
      subscription: false,
      cliConsent: false,
    },
    upgrade: {
      package: null,
      brew: [],
      selfUpdating:
        "Antigravity updates itself. Run agy update on the computer.",
    },
    environment: {},
    managed: false,
    workspaceTools: false,
    agentMail: false,
    midTurn: "queue",
    provider: "antigravity",
    activityTransport: "native",
    launchPermissionMode: false,
    cliSignIn: null,
    importWorktree: false,
    history: "Loop-managed history; native resume",
  },
  muse: {
    label: "Muse Code",
    executable: "muse",
    // Account sign-in and login methods on the experimental MSP surface.
    minimumVersion: "1.4.12",
    installUrl: "https://dev.meta.ai/docs/muse-code/",
    runtime: true,
    billing: {
      default: "existing",
      subscription: false,
      cliConsent: false,
    },
    upgrade: {
      package: null,
      brew: [],
      selfUpdating:
        "Muse Code updates itself. Run muse on the computer to check for an update now.",
    },
    environment: {},
    managed: false,
    workspaceTools: true,
    agentMail: true,
    midTurn: "steer",
    provider: "muse",
    activityTransport: "native",
    launchPermissionMode: false,
    cliSignIn: null,
    importWorktree: false,
    history: "Loop-managed history; native resume",
  },
  grok: {
    label: "Grok Build",
    executable: "grok",
    // ACP over grok agent stdio, verified with this release.
    minimumVersion: "1.0.70",
    installUrl: "https://x.ai/cli",
    runtime: true,
    billing: {
      default: "existing",
      subscription: false,
      cliConsent: false,
    },
    upgrade: {
      package: null,
      brew: [],
      selfUpdating:
        "Grok Build updates itself. Run grok update on the computer to check for an update now.",
    },
    environment: {
      GROK_DISABLE_AUTOUPDATER: "1",
    },
    managed: false,
    workspaceTools: true,
    agentMail: true,
    midTurn: "queue",
    provider: "grok",
    activityTransport: "acp",
    launchPermissionMode: false,
    cliSignIn: {
      provider: { id: "xai", name: "Grok" },
      methods: [
        {
          id: "oauth",
          type: "oauth",
          label: "Sign in with Grok",
          args: ["login", "--device-auth"],
        },
      ],
      defaultArgs: ["login", "--device-auth"],
      response: { kind: "device-code" },
      domains: [{ name: "accounts.x.ai", subdomains: false }],
    },
    importWorktree: false,
    history: "Loop-managed history; native resume",
  },
  acp: {
    label: "ACP agent",
    executable: null,
    minimumVersion: null,
    installUrl: null,
    runtime: false,
    billing: {
      default: "existing",
      subscription: false,
      cliConsent: false,
    },
    upgrade: {
      package: null,
      brew: [],
      selfUpdating: null,
    },
    environment: {},
    managed: false,
    workspaceTools: true,
    agentMail: true,
    midTurn: "queue",
    provider: "acp",
    activityTransport: "acp",
    launchPermissionMode: false,
    cliSignIn: null,
    importWorktree: false,
    history: "Loop-managed history; native resume",
  },
} as const;

export const harnesses = descriptors satisfies {
  [H in keyof typeof descriptors]: HarnessDescriptor<H>;
};

export type Harness = keyof typeof harnesses;
export const harnessIds = Object.keys(harnesses) as Harness[];
export const Harness = z.enum(harnessIds);
type WithProperty<P extends "runtime" | "managed" | "workspaceTools"> = {
  [H in Harness]: (typeof harnesses)[H][P] extends true ? H : never;
}[Harness];
export type WorkspaceToolHarness = WithProperty<"workspaceTools">;
export type RuntimeHarness = WithProperty<"runtime">;
export const runtimeHarnessIds = harnessIds.filter(
  (name): name is RuntimeHarness => harnesses[name].runtime,
);
export const RuntimeHarness = z.enum(runtimeHarnessIds);
export type ManagedHarness = WithProperty<"managed">;
export const ManagedHarness = z.enum(
  harnessIds.filter((name): name is ManagedHarness => harnesses[name].managed),
);
export function isHarness(name: string): name is Harness {
  return Object.hasOwn(harnesses, name);
}
export function isManagedHarness(name: string): name is ManagedHarness {
  return isHarness(name) && harnesses[name].managed;
}
export function nativeConnectionId(name: Harness) {
  return `native-${name}`;
}
export function harnessLabel(name: string) {
  return isHarness(name) ? harnesses[name].label : name;
}

export function supportsBilling(
  name: Harness,
  mode: "existing" | "subscription",
) {
  return mode === "existing" || harnesses[name].billing.subscription;
}
