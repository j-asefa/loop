import { ToolPicker, type ToolSelection } from "./Tools";
import { useState, type FormEvent } from "react";
import { ArrowRight, Plus } from "lucide-react";
import { api, parse } from "./api";
import { Sheet, Badge } from "./components";
import type { Connection, Agent, Folder } from "../shared/types";
export function CreateAgent({
  connections,
  folders,
  onClose,
  onConnect,
  onCreated,
}: {
  connections: Connection[];
  folders: Folder[];
  onClose: () => void;
  onConnect: () => void;
  onCreated: (a: Agent, folder: string) => void;
}) {
  const [tools, setTools] = useState<ToolSelection[]>([]);
  const connected = connections
    .filter((c) => c.status === "connected")
    .sort(
      (a, b) =>
        Number(parse<any>(b.metadata, {}).authMode === "subscription") -
        Number(parse<any>(a.metadata, {}).authMode === "subscription"),
    );
  const [provider, setProvider] = useState(connected[0]?.provider || "openai"),
    [connection, setConnection] = useState(connected[0]?.id || ""),
    [model, setModel] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const accounts = connected.filter((c) => c.provider === provider);
  const selected = accounts.find((c) => c.id === connection) || accounts[0];
  const models = parse<{ id: string; name: string }[]>(selected?.models, []);
  const chosen = models.find((m) => m.id === model)?.id || models[0]?.id || "";
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const a = await api<Agent>("/agents", {
        tools,
        name: f.get("name"),
        connectionId: selected?.id,
        model: chosen,
        instructions: f.get("instructions"),
      });
      onCreated(a, String(f.get("folder") || ""));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title="Meet your next agent" onClose={onClose}>
      <p className="muted">
        A name, a model, and a little direction. You can change the details
        later.
      </p>
      <form onSubmit={create}>
        <div className="provider-picker">
          {(["codex", "anthropic", "openai"] as const).map((p) => (
            <button
              type="button"
              key={p}
              className={provider === p ? "selected" : ""}
              onClick={() => {
                setProvider(p);
                setConnection("");
                setModel("");
              }}
            >
              <Badge provider={p} />
            </button>
          ))}
        </div>
        {selected ? (
          <>
            <label>
              Connected account
              <select
                value={selected.id}
                onChange={(e) => {
                  setConnection(e.target.value);
                  setModel("");
                }}
              >
                {accounts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model
              <select value={chosen} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                {parse<any>(selected.metadata, {}).authMode === "subscription"
                  ? "Uses your subscription allowance. Provider model limits apply."
                  : "Available to this connection. API-billed."}
              </span>
            </label>
          </>
        ) : (
          <div className="note">
            Connect{" "}
            {provider === "codex"
              ? "ChatGPT"
              : provider === "openai"
                ? "OpenAI"
                : "Claude"}{" "}
            to choose an available model.
            <button type="button" className="text-button" onClick={onConnect}>
              <Plus size={16} />
              Connect account
            </button>
          </div>
        )}
        <label>
          Unique name
          <div className="input-prefix">
            <span>@</span>
            <input
              name="name"
              required
              defaultValue={"scout-" + crypto.randomUUID().slice(0, 4)}
              pattern="[a-zA-Z][a-zA-Z0-9-]{2,31}"
              maxLength={32}
            />
          </div>
        </label>
        <label>
          What should this agent focus on?
          <textarea
            name="instructions"
            rows={3}
            placeholder="A thoughtful research partner who cites sources…"
          />
        </label>
        <label>
          Project
          <select name="folder">
            <option value="">Workspace inbox</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <ToolPicker value={tools} onChange={setTools} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy || !chosen}>
          {busy ? "Creating…" : "Create agent"}
          <ArrowRight size={18} />
        </button>
      </form>
    </Sheet>
  );
}
