import { workspaceApi } from "../shared/workspace-api";
import { callRoute } from "./workspace-api";
import { ConnectionPicker, ModelPicker } from "./ConnectionPicker";
import { ConnectionDetails } from "./ConnectionDetails";
import { RuntimeSetup } from "./RuntimeSetup";
import { EffortSelect } from "./EffortSelect";
import type { ModelOption } from "../shared/models";
import { capabilities } from "./capabilities";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Plus } from "lucide-react";
import { parse } from "./api";
import { executionSourceId } from "./sourceRouting";
import { Sheet, Avatar, providerName } from "./components";
import type { Connection, CreatedAgent } from "../shared/types";
import type {
  AgentSource,
  EnvironmentConnection,
  EnvironmentFolder,
} from "./agentSources";
import { AttachmentList, UploadButton } from "./Attachments";
import { MAX_MESSAGE_FILES, type UploadedFile } from "../shared/uploads";
import { MarkdownDefinitions } from "./MarkdownDefinitions";
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
  const [customize, setCustomize] = useState(false);
  const [nameError, setNameError] = useState(false);
  const [nameRevision, setNameRevision] = useState(0);
  const [definitionsOpen, setDefinitionsOpen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [importedName, setImportedName] = useState("");
  const [requestedModel, setRequestedModel] = useState("");
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
    (item) => (item.sourceId || "") === source && !item.is_workspace,
  );
  useEffect(() => {
    let cancelled = false;
    if (!nameTouched) setLoadingName(true);
    setNameError(false);
    callRoute(workspaceApi.agentSuggestName, {}, source)
      .then((suggestion) => {
        if (!cancelled && !nameTouched) setSuggestedName(suggestion.name);
      })
      .catch(() => {
        if (!cancelled) setNameError(true);
      })
      .finally(() => {
        if (!cancelled) setLoadingName(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, nameRevision]);
  const nativeConnection = !!parse<any>(selected?.metadata, {}).loopHarness
    ? selected?.id || ""
    : "";
  const [catalog, setCatalog] = useState<{
    connectionId: string;
    source: string;
    models?: ModelOption[];
    error?: string;
  }>();
  const [catalogRevision, setCatalogRevision] = useState(0);
  useEffect(() => {
    if (!nativeConnection) return;
    let current = true;
    setCatalog({ connectionId: nativeConnection, source });
    void callRoute(
      workspaceApi.connectionModels,
      { params: { id: nativeConnection } },
      source,
    ).then(
      ({ models }) => {
        if (current)
          setCatalog({ connectionId: nativeConnection, source, models });
      },
      (error: Error) => {
        if (current)
          setCatalog({
            connectionId: nativeConnection,
            source,
            error: error.message,
          });
      },
    );
    return () => {
      current = false;
    };
  }, [nativeConnection, source, catalogRevision]);
  const currentCatalog =
    catalog?.connectionId === nativeConnection && catalog.source === source
      ? catalog
      : undefined;
  const refreshingModels =
    !!nativeConnection && !currentCatalog?.models && !currentCatalog?.error;
  const models = nativeConnection
    ? currentCatalog?.models || []
    : parse<ModelOption[]>(selected?.models, []);
  const missingDefinitionModel =
    !!requestedModel && !models.some((m) => m.id === requestedModel);
  const chosen = missingDefinitionModel
    ? ""
    : models.find((m) => m.id === model)?.id ||
      models.find((m) => ["native-default", "default"].includes(m.id))?.id ||
      models.find((m) => m.effortLevels?.length)?.id ||
      models[0]?.id ||
      "";
  const chosenModel = models.find((m) => m.id === chosen);
  const invalidEffort =
    !!effort &&
    !chosenModel?.effortLevels?.some((level) => level.value === effort);
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
    if (
      locked.current ||
      uploading ||
      !selected ||
      !name.trim() ||
      !chosen ||
      refreshingModels ||
      invalidEffort
    )
      return;
    if (crossSource && attachments.length) {
      setError(
        `Files uploaded to ${currentSourceName} can’t be sent to another runtime. Remove them or choose a runner on ${currentSourceName}.`,
      );
      return;
    }
    const data = {
      name: name.trim().toLowerCase(),
      connectionId: selected.id,
      model: chosen,
      effort: effort || null,
      instructions,
      initialPrompt: initialPrompt.trim(),
      attachmentIds: attachments.map((file) => file.id),
      folderId: availableFolders.some((folder) => folder.id === folderChoice)
        ? folderChoice
        : undefined,
    };
    const signature = JSON.stringify({ source, ...data });
    if (request.current.signature !== signature)
      request.current = { signature, key: crypto.randomUUID() };
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const a = await callRoute(
        workspaceApi.agentCreate,
        { body: { ...data, idempotencyKey: request.current.key } },
        source,
      );
      await onCreated(a, data.folderId || "", source);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const setupBlock = capabilities.localProjects ? (
    <details className="runtime-setup-options" open={!connected.length}>
      <summary>More connection options</summary>
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
    </details>
  ) : null;
  if (definitionsOpen)
    return (
      <MarkdownDefinitions
        key={source}
        kind="agent"
        sourceId={source}
        onClose={() => setDefinitionsOpen(false)}
        onUse={(definition) => {
          if (definition.spec.kind !== "agent") return;
          const spec = definition.spec;
          setTypedName(spec.name);
          setNameTouched(true);
          setInstructions(spec.instructions);
          setImportedName(spec.name);
          const requested = spec.model === "inherit" ? "" : spec.model || "";
          setRequestedModel(requested);
          setModel(requested || chosen);
          setEffort(spec.effort || "");
          setCustomize(true);
          setDefinitionsOpen(false);
        }}
      />
    );
  return (
    <Sheet
      title="New chat"
      onClose={onClose}
      dismissible={!busy}
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
            invalidEffort ||
            !name.trim() ||
            (!!attachments.length && !initialPrompt.trim()) ||
            crossSource
          }
        >
          {busy ? "Starting…" : "Start chatting"}
          <ArrowRight size={18} />
        </button>
      }
    >
      <div className="create-agent-welcome">
        <Avatar name={name || "Loop"} />
        <div>
          <strong>
            {name ? `Meet ${name}` : "A little help with anything"}
          </strong>
          <p>Ask a question, explore an idea, or get things done.</p>
        </div>
      </div>
      <form id={formId} onSubmit={create}>
        <label className="create-agent-message">
          <span>
            First message <span className="muted">(optional)</span>
          </span>
          <textarea
            name="initialPrompt"
            autoCorrect="on"
            autoCapitalize="sentences"
            spellCheck={true}
            aria-label="First message"
            rows={3}
            maxLength={30000}
            required={attachments.length > 0}
            disabled={busy || uploading}
            value={initialPrompt}
            onChange={(e) => setInitialPrompt(e.target.value)}
            aria-describedby={attachments.length ? promptHint : undefined}
            placeholder="What’s on your mind?"
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
            disabled={busy || crossSource || !selected}
            remaining={MAX_MESSAGE_FILES - attachments.length}
            onBusy={setUploading}
            onUploaded={(file) => {
              setAttachmentSource(source);
              setAttachments((files) => [...files, file]);
            }}
          />
          <span className="field-hint">Add photos or files</span>
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
        {!!attachments.length && (
          <p className="field-hint" id={promptHint}>
            {crossSource
              ? `These files belong to ${currentSourceName}. Remove them or choose that connection in Customize.`
              : "Add a message to send with your files."}
          </p>
        )}
        {!connected.length && (
          <div className="note create-agent-setup">
            <strong>Connect once to start chatting</strong>
            <p>Link an AI account to use in Loop.</p>
            <button type="button" onClick={onConnect}>
              <Plus size={16} /> Connect an account
            </button>
            {setupBlock}
          </div>
        )}
        {loadingName || refreshingModels ? (
          <p className="field-hint" role="status">
            Getting your chat ready…
          </p>
        ) : null}
        {nameError && !name.trim() && (
          <p className="error" role="alert">
            Couldn’t choose a name. Try again or enter one in Customize.
            <button
              type="button"
              className="text-button"
              onClick={() => setNameRevision((value) => value + 1)}
            >
              Try again
            </button>
          </p>
        )}
        {nativeConnection && currentCatalog?.error && (
          <div className="error" role="alert">
            Couldn’t get this connection ready. Try again or choose another in
            Customize.
            <button
              type="button"
              className="text-button"
              disabled={busy || uploading}
              onClick={() => {
                setCatalog({ connectionId: nativeConnection, source });
                setCatalogRevision((revision) => revision + 1);
              }}
            >
              Try again
            </button>
          </div>
        )}
        {selected &&
          !refreshingModels &&
          !currentCatalog?.error &&
          !models.length && (
            <p className="error" role="alert">
              This connection isn’t ready to chat. Choose another in Customize.
            </p>
          )}
        {!selected && connected.length > 0 && (
          <p className="note" role="status">
            Choose a connected account in Customize to start chatting.
          </p>
        )}
        {missingDefinitionModel && !refreshingModels && (
          <p className="error" role="alert">
            The definition requests {requestedModel}, which is unavailable on
            this connection. Choose a model in Customize.
          </p>
        )}
        {invalidEffort && (
          <p className="error" role="alert">
            This model does not report {effort} effort. Choose a reported effort
            level or the runtime default in Customize.
          </p>
        )}
        <details
          className="advanced-agent-options"
          open={customize}
          onToggle={(event) => setCustomize(event.currentTarget.open)}
        >
          <summary>Customize</summary>
          <div className="create-agent-settings">
            <label>
              Name
              <div className="input-prefix">
                <span>@</span>
                <input
                  name="name"
                  aria-label="Unique name"
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
                  onInvalid={() => setCustomize(true)}
                  placeholder={
                    loadingName ? "Choosing a name…" : "Choose a name"
                  }
                  pattern="[a-zA-Z][a-zA-Z0-9-]{2,31}"
                  maxLength={32}
                  disabled={busy || uploading}
                />
              </div>
            </label>
            <label>
              Agent instructions
              <textarea
                name="instructions"
                autoCorrect="on"
                autoCapitalize="sentences"
                spellCheck={true}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                aria-label="Agent instructions"
                rows={3}
                maxLength={12000}
                disabled={busy || uploading}
                aria-describedby={instructionsHint}
                placeholder="Keep answers concise and explain things simply."
              />
            </label>
            <p className="field-hint" id={instructionsHint}>
              Guidance for every conversation. You can change it later.
            </p>
            <button
              type="button"
              className="text-button"
              disabled={busy || uploading}
              onClick={() => setDefinitionsOpen(true)}
            >
              From Markdown
            </button>
            {importedName && (
              <p className="field-hint">
                Using {importedName} as a starting point.
              </p>
            )}
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
                <option value="">Workspace</option>
                {availableFolders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Provider
              <select
                aria-label="Provider"
                disabled={busy || uploading}
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value as typeof provider);
                  setConnection("");
                  setModel("");
                  setRequestedModel("");
                  setEffort("");
                }}
              >
                {(
                  [
                    "codex",
                    "anthropic",
                    "pi",
                    "opencode",
                    "gemini",
                    "muse",
                    "grok",
                    "acp",
                    "openai",
                  ] as const
                ).map((p) => (
                  <option key={p} value={p}>
                    {providerName(p)}
                  </option>
                ))}
              </select>
            </label>
            {selected ? (
              <>
                <ConnectionPicker
                  disabled={busy || uploading}
                  value={connectionKey(selected)}
                  onChange={(value) => {
                    if (value.startsWith("setup-source:")) {
                      onSourceSetup?.(value.slice("setup-source:".length));
                      return;
                    }
                    setConnection(value);
                    setFolderChoice("");
                    setModel("");
                    setRequestedModel("");
                    setEffort("");
                  }}
                >
                  {accounts.map((c) => (
                    <option key={connectionKey(c)} value={connectionKey(c)}>
                      {c.label.startsWith(
                        c.executionEnvironment || "This computer",
                      )
                        ? c.label
                        : `${c.executionEnvironment || "This computer"} · ${c.label}`}
                    </option>
                  ))}
                  {setupSources.map((item) => (
                    <option key={item.id} value={`setup-source:${item.id}`}>
                      {item.name} · connect {providerName(provider)}
                    </option>
                  ))}
                </ConnectionPicker>
                <ModelPicker
                  models={models}
                  value={chosen}
                  onChange={(value) => {
                    setModel(value);
                    setRequestedModel("");
                    setEffort("");
                  }}
                  disabled={busy || uploading || refreshingModels}
                  refreshing={refreshingModels}
                />
                <EffortSelect
                  model={chosenModel}
                  value={effort}
                  onChange={setEffort}
                />
                <ConnectionDetails connection={selected} />
              </>
            ) : connected.length > 0 ? (
              <div className="note">
                Connect {providerName(provider)} to use it here.
                <button
                  type="button"
                  className="text-button"
                  onClick={onConnect}
                >
                  <Plus size={16} /> Connect on{" "}
                  {sources.find((item) => !item.id)?.name || "This computer"}
                </button>
                {setupSources.map((item) => (
                  <button
                    type="button"
                    className="text-button"
                    key={item.id}
                    onClick={() => onSourceSetup?.(item.id)}
                  >
                    <Plus size={16} /> Connect on {item.name}
                  </button>
                ))}
              </div>
            ) : null}
            {connected.length > 0 && setupBlock}
          </div>
        </details>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Sheet>
  );
}
