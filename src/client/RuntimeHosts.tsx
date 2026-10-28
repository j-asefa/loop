import { literalEntry, proseEntry } from "./textEntry";
import { capabilities } from "./capabilities";
import { PairedDevices } from "./PairedDevices";
import { useEffect, useState } from "react";
import {
  BookOpen,
  Box,
  Link,
  Server,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import {
  workspaceApi,
  type RouteInput,
  type RouteResponse,
} from "../shared/workspace-api";
import { useProjectionRoute, useSourceRoute } from "./SourceContext";
type HostKind = RouteInput<
  typeof workspaceApi.runtimeHostCreate
>["body"]["kind"];
import { Sheet } from "./components";
import {
  SettingsCommand,
  SettingsEmpty,
  SettingsList,
  SettingsNote,
  SettingsRow,
  SettingsSection,
  SettingsSteps,
} from "./SettingsUI";
function ServerRuntimeHosts({
  onClose,
  onAdded,
  initialKind = "codex-app-server",
}: {
  onClose: () => void;
  onAdded?: (
    host: RouteResponse<typeof workspaceApi.runtimeHostCreate>,
  ) => void;
  initialKind?: HostKind;
}) {
  const read = useProjectionRoute(),
    call = useSourceRoute();
  const [hosts, setHosts] = useState<
      RouteResponse<typeof workspaceApi.runtimeHostList>
    >([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [kind, setKind] = useState<HostKind>(initialKind),
    [detail, setDetail] = useState("");
  const command =
    kind === "codex-app-server"
      ? `codex login
umask 077
mkdir -p "$HOME/.codex"
test -f "$HOME/.codex/loop-app-server-token" || openssl rand -hex 32 > "$HOME/.codex/loop-app-server-token"
codex app-server --listen ws://127.0.0.1:4500 --ws-auth capability-token --ws-token-file "$HOME/.codex/loop-app-server-token"`
      : `claude auth login
umask 077
mkdir -p "$HOME/.config/loop"
test -f "$HOME/.config/loop/host-token" || openssl rand -hex 32 > "$HOME/.config/loop/host-token"
LOOP_RUNTIME_TOKEN_FILE="$HOME/.config/loop/host-token" LOOP_RUNTIME_WORKDIR="/absolute/path/to/your/project" node runtime/host.mjs`;
  async function load() {
    setHosts(await read(workspaceApi.runtimeHostList, {}));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  const kindLabel =
    kind === "codex-app-server"
      ? "Codex app-server"
      : kind === "native-host"
        ? "Native host · Codex & Claude Code"
        : "Loop runtime broker";
  const guide =
    kind === "codex-app-server"
      ? {
          url: "https://learn.chatgpt.com/docs/app-server",
          label: "Codex app-server setup",
        }
      : {
          url: "https://github.com/j-asefa/loop/blob/main/docs/feedback/RUNTIMES.md#native-host-for-claude-code-and-codex",
          label: "Native host setup",
        };
  return (
    <Sheet title="Runtime machines" onClose={onClose}>
      <p className="settings-intro">Run agents on your own computer.</p>
      {hosts.length > 0 ? (
        <SettingsSection title="Connected machines">
          <SettingsList>
            {hosts.map((h) => (
              <SettingsRow
                key={h.id}
                icon={Server}
                title={h.name}
                description={
                  (h.kind === "codex-app-server"
                    ? "Codex app-server"
                    : h.kind === "native-host"
                      ? "Native host"
                      : "Loop runtime broker") +
                  " · " +
                  h.url
                }
                state={
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await call(workspaceApi.runtimeHostDelete, {
                          params: { id: h.id },
                          body: {},
                        });
                        await load();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Remove machine
                  </button>
                }
              />
            ))}
          </SettingsList>
        </SettingsSection>
      ) : (
        <SettingsEmpty icon={Server} title="No machines added">
          Add one to give agents your files, commands and local tools.
        </SettingsEmpty>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget,
            f = new FormData(form);
          setBusy(true);
          setError("");
          try {
            const added = await call(workspaceApi.runtimeHostCreate, {
              body: {
                name: String(f.get("name") || ""),
                url: String(f.get("url") || ""),
                token: String(f.get("token") || ""),
                kind,
              },
            });
            form.reset();
            await load();
            onAdded?.(added);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Connection type
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as HostKind);
              setError("");
              setDetail("");
            }}
            disabled={busy}
          >
            <option value="broker">Loop runtime broker</option>
            <option value="codex-app-server">Codex app-server</option>
            <option value="native-host">
              Native host · Codex & Claude Code
            </option>
          </select>
        </label>
        {kind === "broker" ? (
          <SettingsNote icon={Box} title="Isolated containers">
            The broker runs isolated containers. Use a native host or Codex
            app-server to work directly with your laptop’s files and tools.
          </SettingsNote>
        ) : (
          <>
            <SettingsSection title={"Set up " + kindLabel}>
              <SettingsSteps>
                <li>
                  <p>
                    {kind === "codex-app-server"
                      ? "Install Codex and open a terminal in the project directory on that machine."
                      : "Install Node 24+ and Claude Code, then open a terminal in your Loop checkout."}
                  </p>
                </li>
                <li>
                  <p>
                    Run the setup command and leave the process running.
                    {kind === "native-host" && (
                      <small className="field-hint">
                        Replace the project path in the command first.
                      </small>
                    )}
                  </p>
                </li>
              </SettingsSteps>
              <SettingsCommand title="Setup command" command={command} />
              <SettingsList>
                <SettingsRow
                  icon={ShieldAlert}
                  title="What agents can do there"
                  description="Full native tool access on that host"
                  onClick={() => setDetail(detail === "access" ? "" : "access")}
                />
                <SettingsRow
                  icon={Link}
                  title="Private addresses & tunnels"
                  description="Reaching a machine behind a firewall"
                  onClick={() =>
                    setDetail(detail === "network" ? "" : "network")
                  }
                />
                <SettingsRow
                  icon={BookOpen}
                  title={guide.label}
                  description="Open the full guide"
                  onClick={() => window.open(guide.url, "_blank", "noopener")}
                />
              </SettingsList>
              {detail === "access" && (
                <div className="settings-card">
                  <p className="field-hint">
                    {kind === "codex-app-server"
                      ? "Codex’s WebSocket transport is experimental. Agents have full native tool access, including commands, file edits and the MCPs configured on that host. Host administrator policies still apply, and your account stays signed in on that machine when you disconnect Loop."
                      : "This grants agents access to your host’s shell, files, network, skills and configured MCPs. Your account stays signed in on that machine when you disconnect Loop."}
                  </p>
                </div>
              )}
              {detail === "network" && (
                <div className="settings-card">
                  <p className="field-hint">
                    Connect the machine to the Loop server using an SSH tunnel
                    or a private encrypted proxy. The address below must be
                    reachable from the Loop server, including its containers.
                  </p>
                  <p className="field-hint">
                    Add the machine’s origin to{" "}
                    <code>LOOP_ALLOWED_RUNTIME_ORIGINS</code> on the Loop
                    server, then restart the API and worker. The browser’s
                    localhost is not the remote machine.
                  </p>
                </div>
              )}
            </SettingsSection>
          </>
        )}
        <h3>Add the machine</h3>
        <label>
          Machine name
          <input
            {...proseEntry}
            name="name"
            required
            maxLength={80}
            placeholder="My workstation"
          />
        </label>
        <label>
          Runtime address
          <input
            {...literalEntry}
            name="url"
            type="url"
            required
            key={kind}
            placeholder={
              kind === "codex-app-server"
                ? "wss://codex.example.com"
                : "https://runner.example.com"
            }
          />
        </label>
        <label>
          Runtime access token
          <input
            {...literalEntry}
            name="token"
            type="password"
            key={kind}
            required
            minLength={32}
          />
        </label>
        {error && (
          <SettingsNote
            icon={TriangleAlert}
            tone="attention"
            role="alert"
            title="Could not add that machine"
          >
            {error}
          </SettingsNote>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "Checking…" : "Test & add machine"}
        </button>
      </form>
      <p className="field-hint">
        Choose this machine under Run on when adding a subscription connection.
        Command-based MCP servers require a Loop runtime broker.
      </p>
    </Sheet>
  );
}

export function RuntimeHosts(props: Parameters<typeof ServerRuntimeHosts>[0]) {
  return capabilities.runtimeHosts ? (
    <ServerRuntimeHosts {...props} />
  ) : capabilities.pairedDevices ? (
    <PairedDevices {...props} />
  ) : null;
}
