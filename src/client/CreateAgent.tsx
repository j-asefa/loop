import { useId, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Plus } from "lucide-react";
import { api, parse } from "./api";
import { Sheet, Badge } from "./components";
import type { Connection, CreatedAgent, Folder } from "../shared/types";
export function CreateAgent({
  connections,
  folders,
  initialFolder = "",
  onClose,
  onConnect,
  onCreated,
}: {
  connections: Connection[];
  folders: Folder[];
  initialFolder?: string;
  onClose: () => void;
  onConnect: () => void;
  onCreated: (a: CreatedAgent, folder: string) => void | Promise<void>;
}) {
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
    [initialPrompt, setInitialPrompt] = useState(""),
    [suggestedName] = useState(
      () => "scout-" + crypto.randomUUID().slice(0, 4),
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const instructionsHint = useId(),
    promptHint = useId();
  const locked = useRef(false),
    request = useRef({ signature: "", key: "" });
  const accounts = connected.filter((c) => c.provider === provider);
  const selected = accounts.find((c) => c.id === connection) || accounts[0];
  const models = parse<{ id: string; name: string }[]>(selected?.models, []);
  const chosen = models.find((m) => m.id === model)?.id || models[0]?.id || "";
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (locked.current) return;
    const f = new FormData(e.currentTarget);
    const data = {
      name: String(f.get("name") || "")
        .trim()
        .toLowerCase(),
      connectionId: selected?.id,
      model: chosen,
      instructions: String(f.get("instructions") || ""),
      initialPrompt: initialPrompt.trim(),
      folderId: String(f.get("folder") || "") || undefined,
    };
    const signature = JSON.stringify(data);
    if (request.current.signature !== signature)
      request.current = { signature, key: crypto.randomUUID() };
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const a = await api<CreatedAgent>("/agents", {
        ...data,
        idempotencyKey: request.current.key,
      });
      await onCreated(a, data.folderId || "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      locked.current = false;
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
              disabled={busy}
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
                disabled={busy}
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
              <select
                disabled={busy}
                value={chosen}
                onChange={(e) => setModel(e.target.value)}
              >
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
              defaultValue={suggestedName}
              pattern="[a-zA-Z][a-zA-Z0-9-]{2,31}"
              maxLength={32}
              disabled={busy}
            />
          </div>
        </label>
        <label>
          Agent instructions
          <textarea
            name="instructions"
            aria-label="Agent instructions"
            rows={3}
            maxLength={12000}
            disabled={busy}
            aria-describedby={instructionsHint}
            placeholder="Research carefully, cite sources, and keep answers concise."
          />
        </label>
        <p className="field-hint" id={instructionsHint}>
          Optional. Guidance for every task, such as the agent’s role, focus, or
          writing style. You can edit it later.
        </p>
        <label>
          Initial prompt
          <textarea
            name="initialPrompt"
            aria-label="Initial prompt"
            rows={3}
            maxLength={30000}
            disabled={busy}
            value={initialPrompt}
            onChange={(e) => setInitialPrompt(e.target.value)}
            aria-describedby={promptHint}
            placeholder="Find three promising ideas for my next project…"
          />
        </label>
        <p className="field-hint" id={promptHint}>
          Optional. Your first message to this agent. It starts work when you
          create the agent. Leave blank to start later.
        </p>
        <label>
          Project
          <select
            name="folder"
            aria-label="Project"
            disabled={busy}
            defaultValue={initialFolder}
          >
            <option value="">Workspace inbox</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <span className="field-hint">
            This agent belongs to the project. New conversations save their
            outputs there.
          </span>
        </label>
        <p className="field-hint">
          Connected MCP tools are available to every agent in your workspace.
          Manage tools and approval preferences in Settings → Tools &amp;
          integrations.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy || !chosen}>
          {busy
            ? "Creating…"
            : initialPrompt.trim()
              ? "Create & start"
              : "Create agent"}
          <ArrowRight size={18} />
        </button>
      </form>
    </Sheet>
  );
}
