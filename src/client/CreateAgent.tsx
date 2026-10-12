import { ConnectionDetails } from "./ConnectionDetails";
import { RuntimeSetup } from "./RuntimeSetup";
import { EffortSelect } from "./EffortSelect";
import type { ModelOption } from "../shared/models";
import { capabilities } from "./capabilities";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Plus } from "lucide-react";
import { api, apiInWorkspace, parse } from "./api";
import { executionSourceId } from "./sourceRouting";
import { Sheet, Badge, providerName } from "./components";
import type { Connection, CreatedAgent } from "../shared/types";
import type {
  AgentSource,
  EnvironmentConnection,
  EnvironmentFolder,
} from "./agentSources";
import { modelDisplayName } from "./modelChoices";
import { AttachmentList, UploadButton } from "./Attachments";
import { MAX_MESSAGE_FILES, type UploadedFile } from "../shared/uploads";
export function CreateAgent({
  connections,
  folders,
  sources = [],
  initialFolder = "",
  initialPromptText = "",
  preferredEnvironmentId = "",
  preferredProvider = "",
  onClose,
  onConnect,
  onSourceSetup,
  onEnvironmentSetup,
  onConnectionsChanged,
  onCreated,
}: {
  connections: EnvironmentConnection[];
  folders: EnvironmentFolder[];
  sources?: AgentSource[];
  initialFolder?: string;
  initialPromptText?: string;
  preferredEnvironmentId?: string;
  preferredProvider?: string;
  onClose: () => void;
  onConnect: () => void;
  onSourceSetup?: (sourceId: string) => void;
  onEnvironmentSetup: (environmentId: string, provider: string) => void;
  onConnectionsChanged: () => Promise<Connection[]>;
  onCreated: (
    a: CreatedAgent,
    folder: string,
    sourceId: string,
  ) => void | Promise<void>;
}) {
  const connectionKey = (item: EnvironmentConnection) =>
    `${item.sourceId || "laptop"}:${item.id}`;
  const connected = connections
    .filter((c) => c.status === "connected")
    .sort(
      (a, b) =>
        Number(!!a.sourceId) - Number(!!b.sourceId) ||
        Number(parse<any>(b.metadata, {}).authMode === "subscription") -
          Number(parse<any>(a.metadata, {}).authMode === "subscription"),
    );
  const preferredConnection = connected.find((item) => {
    return (
      item.provider === preferredProvider &&
      (!preferredEnvironmentId || item.sourceId === preferredEnvironmentId)
    );
  });
  const [provider, setProvider] = useState(
      preferredConnection?.provider || connected[0]?.provider || "openai",
    ),
    [connection, setConnection] = useState(
      preferredConnection
        ? connectionKey(preferredConnection)
        : connected[0]
          ? connectionKey(connected[0])
          : "",
    ),
    [model, setModel] = useState(""),
    [effort, setEffort] = useState(""),
    [initialPrompt, setInitialPrompt] = useState(initialPromptText),
    [attachments, setAttachments] = useState<UploadedFile[]>([]),
    [attachmentSource, setAttachmentSource] = useState(""),
    [uploading, setUploading] = useState(false),
    [folderChoice, setFolderChoice] = useState(initialFolder),
    [suggestedName, setSuggestedName] = useState(""),
    [typedName, setTypedName] = useState(""),
    [nameTouched, setNameTouched] = useState(false),
    [loadingName, setLoadingName] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const formId = useId();
  const instructionsHint = useId(),
    promptHint = useId();
  const locked = useRef(false),
    request = useRef({ signature: "", key: "" });
  // The suggestion arrives asynchronously. Once the person enters the field it
  // must not change underneath them: a late suggestion would land between
  // their caret placement and first keystroke and merge into what they type.
  const name = nameTouched ? typedName : suggestedName;
  const accounts = connected.filter((c) => c.provider === provider);
  const selected =
    accounts.find((c) => connectionKey(c) === connection) || accounts[0];
  const source = selected?.sourceId || "";
  const availableFolders = folders.filter(
    (item) => (item.sourceId || "") === source,
  );
  useEffect(() => {
    let cancelled = false;
    if (!nameTouched) setLoadingName(true);
    apiInWorkspace<{ name: string }>("/agents/suggest-name", source)
      .then((suggestion) => {
        if (!cancelled && !nameTouched) setSuggestedName(suggestion.name);
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
  }, [source]);
  const nativeConnection = !!parse<any>(selected?.metadata, {}).loopHarness
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
    void apiInWorkspace<{ models: ModelOption[] }>(
      `/connections/${nativeConnection}/models`,
      source,
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
  }, [nativeConnection, source, catalogRevision]);
  const currentCatalog =
    catalog?.connectionId === nativeConnection ? catalog : undefined;
  const refreshingModels =
    !!nativeConnection && !currentCatalog?.models && !currentCatalog?.error;
  const models = nativeConnection
    ? currentCatalog?.models || []
    : parse<ModelOption[]>(selected?.models, []);
  const chosen =
    models.find((m) => m.id === model)?.id ||
    models.find((m) => m.effortLevels?.length)?.id ||
    models[0]?.id ||
    "";
  const setupSources = ["codex", "anthropic", "openai"].includes(provider)
    ? sources.filter(
        (item) =>
          item.id &&
          item.id !== executionSourceId() &&
          !accounts.some((account) => account.sourceId === item.id),
      )
    : [];
  const currentSourceName =
    sources.find((item) => item.id === attachmentSource)?.name ||
    "the original runtime";
  // Uploaded IDs belong to one source, even if the runner changes later.
  const crossSource = attachments.length > 0 && source !== attachmentSource;
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (locked.current || uploading || !chosen || refreshingModels) return;
    const f = new FormData(e.currentTarget);
    if (crossSource && attachments.length) {
      setError(
        `Files uploaded to ${currentSourceName} can’t be sent to another runtime. Remove them or choose a runner on ${currentSourceName}.`,
      );
      return;
    }
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
      folderId: availableFolders.some(
        (folder) => folder.id === String(f.get("folder") || ""),
      )
        ? String(f.get("folder"))
        : undefined,
    };
    const signature = JSON.stringify({ source, ...data });
    if (request.current.signature !== signature)
      request.current = { signature, key: crypto.randomUUID() };
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const a = await apiInWorkspace<CreatedAgent>("/agents", source, {
        ...data,
        idempotencyKey: request.current.key,
      });
      await onCreated(a, data.folderId || "", source);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  // First-time setup leads; once a runtime is connected it moves below the form.
  const setupBlock = (
    <details className="runtime-setup-options" open={!connected.length}>
      <summary>Runtimes and execution environments</summary>
      {capabilities.localProjects && (
        <div>
          <p className="field-hint">
            Choose or enable a runtime on this computer.
          </p>
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
                setConnection(connectionKey(next));
              }
              setCatalogRevision((revision) => revision + 1);
            }}
          />
        </div>
      )}
    </details>
  );
  return (
    <Sheet
      title="Meet your next agent"
      onClose={onClose}
      className="create-agent-sheet"
      footer={
        <button
          className="primary"
          type="submit"
          form={formId}
          disabled={
            busy ||
            uploading ||
            refreshingModels ||
            !chosen ||
            !name.trim() ||
            (!!attachments.length && !initialPrompt.trim()) ||
            crossSource
          }
        >
          {busy
            ? "Creating…"
            : initialPrompt.trim()
              ? "Create & start"
              : "Create agent"}
          <ArrowRight size={18} />
        </button>
      }
    >
      <p className="muted">
        Pick a project and a model. Everything else is optional and can change
        later.
      </p>
      {!connected.length && setupBlock}
      <form id={formId} onSubmit={create}>
        <label>
          Project
          <select
            name="folder"
            aria-label="Project"
            disabled={busy || uploading}
            value={
              availableFolders.some((item) => item.id === folderChoice)
                ? folderChoice
                : ""
            }
            onChange={(event) => setFolderChoice(event.target.value)}
          >
            <option value="">No project (unfiled)</option>
            {availableFolders.map((f) => (
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
        <div className="provider-picker">
          {(
            ["codex", "anthropic", "pi", "opencode", "acp", "openai"] as const
          ).map((p) => (
            <button
              type="button"
              key={p}
              disabled={busy || uploading}
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
              Run on
              <select
                disabled={busy || uploading}
                value={connectionKey(selected)}
                onChange={(e) => {
                  if (e.target.value.startsWith("setup-source:")) {
                    onSourceSetup?.(
                      e.target.value.slice("setup-source:".length),
                    );
                    return;
                  }
                  setConnection(e.target.value);
                  setFolderChoice("");
                  setModel("");
                }}
              >
                {accounts.map((c) => (
                  <option key={connectionKey(c)} value={connectionKey(c)}>
                    {c.label.startsWith(c.executionEnvironment || "This computer")
                      ? c.label
                      : `${c.executionEnvironment || "This computer"} · ${c.label}`}
                  </option>
                ))}
                {setupSources.map((item) => (
                  <option key={item.id} value={`setup-source:${item.id}`}>
                    {item.name} · connect {providerName(provider)}
                  </option>
                ))}
              </select>
            </label>
            <p className="field-hint">
              Runs on {selected.executionEnvironment || "This computer"}.
            </p>
            <ConnectionDetails connection={selected} />
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
            </label>
            {nativeConnection && currentCatalog?.error && (
              <div>
                <p className="error" role="alert">
                  Could not refresh available models. {currentCatalog.error}
                </p>
                <button
                  type="button"
                  disabled={busy || uploading}
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
            {
              <button type="button" className="text-button" onClick={onConnect}>
                <Plus size={16} />
                Connect on {currentSourceName}
              </button>
            }
            {setupSources.map((item) => (
              <button
                type="button"
                className="text-button"
                key={item.id}
                onClick={() => onSourceSetup?.(item.id)}
              >
                <Plus size={16} />
                Connect on {item.name}
              </button>
            ))}
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
              onFocus={(e) => {
                if (nameTouched) return;
                setTypedName(e.currentTarget.value);
                setNameTouched(true);
              }}
              onChange={(e) => {
                setNameTouched(true);
                setTypedName(e.target.value);
              }}
              placeholder={loadingName ? "Choosing a name…" : "Choose a name"}
              pattern="[a-zA-Z][a-zA-Z0-9-]{2,31}"
              maxLength={32}
              disabled={busy || uploading}
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
              disabled={busy || uploading}
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
            disabled={busy || uploading}
            value={initialPrompt}
            onChange={(e) => setInitialPrompt(e.target.value)}
            aria-describedby={promptHint}
            placeholder="Find three promising ideas for my next project…"
          />
        </label>
        <div className="initial-prompt-attachments">
          <UploadButton
            menu
            sourceId={source}
            folderId={
              availableFolders.some((folder) => folder.id === folderChoice)
                ? folderChoice
                : undefined
            }
            disabled={busy || crossSource}
            remaining={MAX_MESSAGE_FILES - attachments.length}
            onBusy={setUploading}
            onUploaded={(file) => {
              setAttachmentSource(source);
              setAttachments((files) => [...files, file]);
            }}
          />
          <span className="field-hint">
            {crossSource
              ? `These files belong to ${currentSourceName}. Remove them or select that runtime to continue.`
              : "Add photos or files to your first message"}
          </span>
        </div>
        <AttachmentList
          sourceId={attachmentSource}
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
      </form>
      {connected.length > 0 && setupBlock}
    </Sheet>
  );
}
