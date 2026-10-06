import {
  Bell,
  Bookmark,
  ChevronRight,
  Download,
  Link,
  MessageSquare,
  Monitor,
  Orbit,
  Plug,
  Search,
  Server,
  Smartphone,
  type LucideIcon,
} from "lucide-react";
import { capabilities } from "./capabilities";

export function SettingsHome({
  open,
  theme,
  onTheme,
}: {
  open: (page: string) => void;
  theme: string;
  onTheme: (theme: "system" | "light" | "dark") => void;
}) {
  const row = (
    page: string,
    title: string,
    description: string,
    Icon: LucideIcon,
  ) => (
    <button
      type="button"
      className="settings-row"
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
              "Accounts, models & coding harnesses",
              Link,
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
            {capabilities.runtimeHosts &&
              row(
                "runtime-hosts",
                "Runtime machines",
                "Machines for API & command tools",
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
              "Models, instructions & preferences",
              Orbit,
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
