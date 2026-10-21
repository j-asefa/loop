import {
  Bell,
  Bookmark,
  ChevronRight,
  Download,
  Link,
  KeyRound,
  MessageSquare,
  Monitor,
  Orbit,
  Plug,
  Search,
  Server,
  Smartphone,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { capabilities } from "./capabilities";
import { SettingsPill } from "./SettingsUI";
import type { Agent, Connection } from "../shared/types";

export function SettingsHome({
  open,
  theme,
  onTheme,
  agents = [],
  connections = [],
}: {
  open: (page: string) => void;
  theme: string;
  onTheme: (theme: "system" | "light" | "dark") => void;
  agents?: Agent[];
  connections?: Connection[];
}) {
  // Only summarize what the workspace has already loaded. A settings row never
  // starts a probe of its own just to show a badge.
  const connected = connections.filter((c) => c.status === "connected").length;
  const unhealthy = connections.length - connected;
  const providerState = !connections.length ? null : unhealthy ? (
    <SettingsPill tone="attention">
      {unhealthy} need{unhealthy === 1 ? "s" : ""} attention
    </SettingsPill>
  ) : (
    <SettingsPill tone="ready">{connected} ready</SettingsPill>
  );
  const row = (
    page: string,
    title: string,
    description: string,
    Icon: LucideIcon,
    state?: ReactNode,
  ) => (
    <button
      type="button"
      className={"settings-row" + (state ? " has-state" : "")}
      aria-label={title}
      onClick={() => open(page)}
      key={page}
    >
      <span className="settings-row-icon">
        <Icon size={20} aria-hidden="true" />
      </span>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      {state}
      <ChevronRight size={18} aria-hidden="true" />
    </button>
  );
  return (
    <>
      <p className="settings-intro">Your workspace, at a glance.</p>
      <nav className="settings-navigation" aria-label="Settings pages">
        <section aria-labelledby="settings-connections">
          <h3 id="settings-connections">Connections</h3>
          <div className="settings-row-group">
            {row(
              "connections",
              "Provider connections",
              "Accounts & coding harnesses",
              Link,
              providerState,
            )}
            {row(
              "environments",
              "Execution environments",
              "Choose where agents run",
              Monitor,
            )}
            {row(
              "mcp",
              "Tools & integrations",
              "Shared tools for your agents",
              Plug,
            )}
            {capabilities.cardTokens === true && row("card-tokens", "Card API tokens", "Read-only access for scripts", KeyRound)}
            {capabilities.runtimeHosts &&
              row(
                "runtime-hosts",
                "Runtime machines",
                "Run agents on your own computer",
                Server,
              )}
          </div>
        </section>
        <section aria-labelledby="settings-workspace">
          <h3 id="settings-workspace">Workspace</h3>
          <div className="settings-row-group">
            {row(
              "agents",
              "Manage agents",
              "Models, instructions & projects",
              Orbit,
              agents.length ? (
                <SettingsPill tone="muted" quiet>
                  {agents.length}
                </SettingsPill>
              ) : undefined,
            )}
            {row(
              "pi-customizations",
              "Pi customizations",
              "Packages, skills & commands",
              Orbit,
            )}
            {row(
              "memory",
              "Shared memory",
              "What your agents can recall",
              Bookmark,
            )}
            {row(
              "search-settings",
              "Search preferences",
              "Keyword & semantic search",
              Search,
            )}
            {row(
              "notifications",
              "Notifications",
              "Manage alerts on this device",
              Bell,
            )}
          </div>
        </section>
      </nav>
      <section
        className="settings-appearance"
        aria-labelledby="appearance-label"
      >
        <h3 id="appearance-label">Appearance</h3>
        <div
          className="drawer-segmented"
          role="group"
          aria-labelledby="appearance-label"
        >
          {(["system", "light", "dark"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={theme === value}
              onClick={() => onTheme(value)}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
      </section>
      <section className="settings-navigation" aria-labelledby="settings-more">
        <h3 id="settings-more">More</h3>
        <div className="settings-row-group">
          {capabilities.nativeHarnesses &&
            row(
              "native-history",
              "Native conversations",
              "Browse existing harness history",
              MessageSquare,
            )}
          {row(
            "import",
            "Import conversations",
            "Bring your saved chats into Loop",
            Download,
          )}
          {row(
            "install",
            "Install on your phone",
            "Add Loop to your home screen",
            Smartphone,
          )}
        </div>
      </section>
    </>
  );
}
