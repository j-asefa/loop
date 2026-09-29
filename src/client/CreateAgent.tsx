import { RuntimeSetup } from "./RuntimeSetup";
import { EffortSelect } from "./EffortSelect";
import type { ModelOption } from "../shared/models";
import { capabilities } from "./capabilities";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Plus } from "lucide-react";
import { api, parse } from "./api";
import { Sheet, Badge, providerName } from "./components";
import type { Connection, CreatedAgent, Folder } from "../shared/types";
import { modelDisplayName } from "./modelChoices";
import { AttachmentList, UploadButton } from "./Attachments";
import { MAX_MESSAGE_FILES, type UploadedFile } from "../shared/uploads";
export function CreateAgent({
  connections,
  folders,
  initialFolder = "",
  onClose,
  onConnect,
  onConnectionsChanged,
  onCreated,
}: {
  connections: Connection[];
  folders: Folder[];
  initialFolder?: string;
  onClose: () => void;
  onConnect: () => void;
  onConnectionsChanged: () => Promise<Connection[]>;
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
    [effort, setEffort] = useState(""),
    [initialPrompt, setInitialPrompt] = useState(""),
    [attachments, setAttachments] = useState<UploadedFile[]>([]),
    [uploading, setUploading] = useState(false),
    [folderChoice, setFolderChoice] = useState(
      initialFolder ||
        (parse<any>(connected[0]?.metadata, {}).backend === "hapi"
          ? folders.find((f) => f.kind === "project")?.id || ""
          : ""),
    ),
    [name, setName] = useState(""),
    [loadingName, setLoadingName] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const instructionsHint = useId(),
    promptHint = useId();
  const locked = useRef(false),
    request = useRef({ signature: "", key: "" }),
    nameEdited = useRef(false);
  useEffect(() => {
    let cancelled = false;
    api<{ name: string }>("/agents/suggest-name")
      .then((suggestion) => {
        if (!cancelled && !nameEdited.current) setName(suggestion.name);
      })
      .catch(() => {
        // Manual naming remains available if suggestions cannot be loaded.
      })
      .finally(() => {
        if (!cancelled) setLoadingName(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const accounts = connected.filter((c) => c.provider === provider);
  const selected = accounts.find((c) => c.id === connection) || accounts[0];
  const nativeConnection = parse<any>(selected?.metadata, {}).loopHarness
    ? selected?.id || ""
    : "";
  const [catalog, setCatalog] = useState<{
    connectionId: string;
    models?: ModelOption[];
    error?: string;
  }>();
  const [catalogRevision, setCatalogRevision] = useState(0);
  useEffect(() => {
    if (!nativeConnection) return;
    let current = true;
    setCatalog({ connectionId: nativeConnection });
    void api<{ models: ModelOption[] }>(
      `/connections/${nativeConnection}/models`,
    ).then(
      ({ models }) => {
        if (current) setCatalog({ connectionId: nativeConnection, models });
      },
      (error: Error) => {
        if (current)
          setCatalog({ connectionId: nativeConnection, error: error.message });
      },
    );
    return () => {
      current = false;
    };
  }, [nativeConnection, catalogRevision]);
  const currentCatalog =
    catalog?.connectionId === nativeConnection ? catalog : undefined;
  const refreshingModels =
    !!nativeConnection && !currentCatalog?.models && !currentCatalog?.error;
  const models = nativeConnection
    ? currentCatalog?.models || []
    : parse<ModelOption[]>(selected?.models, []);
  const chosen = models.find((m) => m.id === model)?.id || models[0]?.id || "";
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (locked.current || uploading || !chosen || refreshingModels) return;
    const f = new FormData(e.currentTarget);
    const data = {
      name: String(f.get("name") || "")
        .trim()
        .toLowerCase(),
      connectionId: selected?.id,
      model: chosen,
      effort: String(f.get("effort") || "") || null,
      instructions: String(f.get("instructions") || ""),
      initialPrompt: initialPrompt.trim(),
      attachmentIds: attachments.map((file) => file.id),
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
      {capabilities.localProjects && (
        <details open={!connected.length}>
          <summary>Choose or enable a runtime on this computer</summary>
          <RuntimeSetup
            onEnabled={async (runtimeName) => {
              const updated = await onConnectionsChanged();
              const next = updated.find(
                (c) =>
                  c.status === "connected" &&
                  parse<any>(c.metadata, {}).loopHarness === runtimeName,
              );
              if (next && !selected) {
                setProvider(next.provider);
                setConnection(next.id);
              }
              setCatalogRevision((revision) => revision + 1);
            }}
          />
        </details>
      )}
      <form onSubmit={create}>
        <div className="provider-picker">
          {(["codex", "anthropic", "pi", "opencode", "acp", "openai"] as const)
            .filter(
              (p) =>
                capabilities.nativeHarnesses ||
                !["pi", "opencode", "acp"].includes(p),
            )
            .map((p) => (
              <button
                type="button"
                key={p}
                disabled={busy}
                className={provider === p ? "selected" : ""}
                aria-pressed={provider === p}
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
              {parse<any>(selected.metadata, {}).backend === "hapi"
                ? "Run on"
                : "Connected account"}
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
                aria-label="Model"
                disabled={busy || refreshingModels || !models.length}
                value={chosen}
                onChange={(e) => setModel(e.target.value)}
              >
                {!models.length && (
                  <option value="">
                    {refreshingModels
                      ? "Checking available models…"
                      : "No models available"}
                  </option>
                )}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {modelDisplayName(m)}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                {parse<any>(selected.metadata, {}).loopHarness
                  ? parse<any>(selected.metadata, {}).billing?.description
                  : parse<any>(selected.metadata, {}).authMode ===
                      "subscription"
                    ? "Uses your subscription allowance. Provider model limits apply."
                    : "Available to this connection. API-billed."}
              </span>
            </label>
            {nativeConnection && currentCatalog?.error && (
              <div>
                <p className="error" role="alert">
                  Could not refresh available models. {currentCatalog.error}
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setCatalog({ connectionId: nativeConnection });
                    setCatalogRevision((revision) => revision + 1);
                  }}
                >
                  Refresh models
                </button>
              </div>
            )}
            <EffortSelect
              model={models.find((m) => m.id === chosen)}
              value={
                models
                  .find((m) => m.id === chosen)
                  ?.effortLevels?.some((level) => level.value === effort)
                  ? effort
                  : ""
              }
              onChange={setEffort}
            />
          </>
        ) : (
          <div className="note">
            Connect {providerName(provider)} to choose an available model.
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
              value={name}
              onChange={(e) => {
                nameEdited.current = true;
                setName(e.target.value);
              }}
              placeholder={loadingName ? "Choosing a name…" : "Choose a name"}
              pattern="[a-zA-Z][a-zA-Z0-9-]{2,31}"
              maxLength={32}
              disabled={busy}
            />
          </div>
        </label>
        <details className="advanced-agent-options">
          <summary>Instructions & advanced options</summary>
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
            Optional. Guidance for every task, such as the agent’s role, focus,
            or writing style. You can edit it later.
          </p>
        </details>
        <label>
          Initial prompt
          <textarea
            name="initialPrompt"
            aria-label="Initial prompt"
            rows={3}
            maxLength={30000}
            required={attachments.length > 0}
            disabled={busy}
            value={initialPrompt}
            onChange={(e) => setInitialPrompt(e.target.value)}
            aria-describedby={promptHint}
            placeholder="Find three promising ideas for my next project…"
          />
        </label>
        <div className="initial-prompt-attachments">
          <UploadButton
            menu
            folderId={folderChoice}
            disabled={busy}
            remaining={MAX_MESSAGE_FILES - attachments.length}
            onBusy={setUploading}
            onUploaded={(file) => setAttachments((files) => [...files, file])}
          />
          <span className="field-hint">
            Add photos or files to your first message
          </span>
        </div>
        <AttachmentList
          files={attachments}
          onRemove={
            busy || uploading
              ? undefined
              : (id) =>
                  setAttachments((files) =>
                    files.filter((file) => file.id !== id),
                  )
          }
        />
        <p className="field-hint" id={promptHint}>
          {attachments.length
            ? "Add a prompt for these files. The agent receives them when its first task starts."
            : "Optional. Your first message to this agent. It starts work when you create the agent. Leave blank to start later."}
        </p>
        <label>
          Project
          <select
            name="folder"
            aria-label="Project"
            disabled={busy}
            value={folderChoice}
            onChange={(event) => setFolderChoice(event.target.value)}
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
        <button
          className="primary"
          disabled={
            busy ||
            uploading ||
            refreshingModels ||
            !chosen ||
            !name.trim() ||
            (!!attachments.length && !initialPrompt.trim())
          }
        >
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
