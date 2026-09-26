import { capabilities } from "./capabilities";
import { PairedDevices } from "./PairedDevices";
import { useEffect, useState } from "react";
import { api } from "./api";
import { Sheet } from "./components";
function ServerRuntimeHosts({ onClose }: { onClose: () => void }) {
  const [hosts, setHosts] = useState<any[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [kind, setKind] = useState("broker");
  async function load() {
    setHosts(await api("/runtime-hosts"));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  return (
    <Sheet title="Runtime machines" onClose={onClose}>
      <p>
        Run agents on your own machine with its files, commands, skills and
        configured tools. Choose Codex app-server or a native host for Claude
        Code.
      </p>
      <p className="note">
        Use an encrypted connection or an SSH tunnel. For a private address, the
        server administrator must add its origin to
        LOOP_ALLOWED_RUNTIME_ORIGINS.
      </p>
      {hosts.map((h) => (
        <div className="connection-card" key={h.id}>
          <strong>{h.name}</strong>
          <p className="muted">
            {h.kind === "codex-app-server"
              ? "Codex app-server"
              : h.kind === "native-host"
                ? "Native host · Codex & Claude Code"
                : "Loop runtime broker"}
          </p>
          <p>{h.url}</p>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api("/runtime-hosts/" + h.id, {}, "DELETE");
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
        </div>
      ))}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget,
            f = new FormData(form);
          setBusy(true);
          setError("");
          try {
            await api("/runtime-hosts", {
              name: f.get("name"),
              url: f.get("url"),
              token: f.get("token"),
              kind,
            });
            form.reset();
            await load();
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
              setKind(e.target.value);
              setError("");
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
        {kind === "codex-app-server" && (
          <div className="note">
            <p>
              Sign in with ChatGPT on that machine using{" "}
              <code>codex login</code>, then start an app-server WebSocket
              listener. Pair its address and access token below.
            </p>
            <p>
              Codex's WebSocket transport is experimental. Your account stays
              signed in on that machine when you disconnect Loop. Agents have
              full native tool access, including commands, file edits and the
              MCPs configured on that host. Host administrator policies still
              apply.
            </p>
            <a
              href="https://learn.chatgpt.com/docs/app-server"
              target="_blank"
              rel="noopener noreferrer"
            >
              Codex app-server setup ↗
            </a>
          </div>
        )}
        {kind === "native-host" && (
          <div className="note">
            <p>
              On your machine, sign in using <code>claude auth login</code> or{" "}
              <code>codex login</code>. Start Loop’s native host runner from the
              project directory, then pair its address and access token here.
            </p>
            <p>
              This grants agents access to your host’s shell, files, network,
              skills and configured MCPs. Your account stays signed in when you
              disconnect Loop.
            </p>
            <a
              href="https://github.com/j-asefa/loop/blob/feat/reported-bugs-and-agent-teams/docs/feedback/RUNTIMES.md#native-host-for-claude-code-and-codex"
              target="_blank"
              rel="noopener noreferrer"
            >
              Native host setup ↗
            </a>
          </div>
        )}
        {kind === "broker" && (
          <p className="note">
            The broker runs isolated containers. Use a native host or Codex
            app-server to work directly with your laptop’s files and tools.
          </p>
        )}
        <label>
          Machine name
          <input
            name="name"
            required
            maxLength={80}
            placeholder="My workstation"
          />
        </label>
        <label>
          Runtime address
          <input
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
            name="token"
            type="password"
            autoComplete="off"
            key={kind}
            required
            minLength={32}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
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
