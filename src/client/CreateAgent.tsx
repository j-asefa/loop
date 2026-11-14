import { useProjectionRoute } from "./SourceContext";
import { IdempotencyKey } from "../shared/contract-ids";
import { ArtifactId } from "../shared/contract-ids.js";
import { ModelId } from "../shared/contract-ids.js";
import { FolderId, parseId } from "../shared/contract-ids.js";
import { literalEntry, proseEntry } from "./textEntry";

import { fleetOperationReason } from "./fleetCapabilities";
import { workspaceApi } from "../shared/workspace-api";
import { callRoute } from "./api";
import {
  CreateAgentModelOptions,
  connectionKey,
} from "./CreateAgentModelOptions";
import { RuntimeSetup } from "./RuntimeSetup";
import type { ModelOption } from "../shared/models";
import { capabilities } from "./capabilities";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Plus } from "lucide-react";
import { parse } from "./json";
import {
  performStoredEffect,
  creationFailureSettled,
  UncertainEffect,
} from "./pendingCommands";
import { viewOwner, viewGeneration } from "./viewCache";
import { executionSourceId } from "./sourceRouting";
import { Sheet, Avatar } from "./components";
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
  const readProjection = useProjectionRoute();

  const connected = connections
    .filter((c) => c.status === "connected")
    .sort(
      (a, b) =>
        Number(!!a.sourceId) - Number(!!b.sourceId) ||
        Number(
          parse<{ authMode?: string; loopHarness?: string }>(b.metadata, {})
            .authMode === "subscription",
        ) -
          Number(
            parse<{ authMode?: string; loopHarness?: string }>(a.metadata, {})
              .authMode === "subscription",
          ),
    );
  const preferredConnection = connected.find((item) => {
    return (
      item.provider === preferredProvider &&
      (!preferredEnvironmentId || item.sourceId === preferredEnvironmentId)
    );
  });
  const [connection, setConnection] = useState(
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
    [nameEdited, setNameEdited] = useState(false),
    [loadingName, setLoadingName] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState<UncertainEffect>();
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
  const locked = useRef(false);
  const mounted = useRef(false);
  const owner = viewOwner(),
    generation = viewGeneration();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The suggestion arrives asynchronously. Once the person enters the field it
  // must not change underneath them: a late suggestion would land between
  // their caret placement and first keystroke and merge into what they type.
  const name = nameTouched ? typedName : suggestedName;
  const selected =
    connected.find((c) => connectionKey(c) === connection) ||
    (!connection ? connected[0] : undefined);
  const source = selected?.sourceId || "";
  const selectedSource = useRef(source);
  selectedSource.current = source;
  const current = () =>
    mounted.current &&
    owner === viewOwner() &&
    generation === viewGeneration() &&
    source === selectedSource.current;
  const sourceCapabilities =
    sources.find((item) => item.id === source)?.capabilities ??
    (source === executionSourceId() ? capabilities : undefined);
  const creationUnavailable = fleetOperationReason(
    source,
    sourceCapabilities,
    workspaceApi.agentCreate,
  );
  const availableFolders = folders.filter(
    (item) => (item.sourceId || "") === source && !item.is_workspace,
  );
  useEffect(() => {
    let cancelled = false;
    if (!nameTouched) setLoadingName(true);
    setNameError(false);
    readProjection(
      workspaceApi.agentSuggestName,
      {},
      { mode: "once", source: source },
    )
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
  const selectedConnection = selected?.id || "";
  const savedModels = parse<ModelOption[]>(selected?.models, []);
  const [catalog, setCatalog] = useState<{
    connectionId: string;
    source: string;
    models?: ModelOption[];
    error?: string;
  }>();
  const [catalogRevision, setCatalogRevision] = useState(0);
  const catalogRequest = useRef<
    | {
        key: string;
        cancel: () => void;
        savedModels?: string;
        succeeded: boolean;
      }
    | undefined
  >(undefined);
  useEffect(
    () => () => {
      catalogRequest.current?.cancel();
      catalogRequest.current = undefined;
    },
    [],
  );
  useEffect(() => {
    const key = JSON.stringify([selectedConnection, source, catalogRevision]);
    const previous = catalogRequest.current;
    if (previous?.key === key) {
      const changed = previous.savedModels !== selected?.models;
      previous.savedModels = selected?.models;
      // Keep pending discovery alive across its own metadata notification.
      // After success, later workspace updates become the current catalog.
      // Failures still require an explicit retry rather than falling back.
      if (previous.succeeded && changed)
        setCatalog({
          connectionId: selectedConnection,
          source,
          models: savedModels,
        });
      return;
    }
    catalogRequest.current?.cancel();
    catalogRequest.current = undefined;
    setCatalog(undefined);
    // Bootstrap already includes the validated catalog. Re-discovering a native
    // harness here can take seconds; only discover missing catalogs or refresh
    // when requested. Creation still validates against the owner's connection.
    if (!selectedConnection || (savedModels.length && !catalogRevision)) return;
    let current = true;
    const discovery = {
      key,
      savedModels: selected?.models,
      succeeded: false,
      cancel: () => {
        current = false;
      },
    };
    catalogRequest.current = discovery;
    setCatalog({ connectionId: selectedConnection, source });
    void readProjection(
      workspaceApi.connectionModels,
      { params: { id: selectedConnection } },
      { mode: "once", source: source },
    ).then(
      ({ models }) => {
        if (current) {
          discovery.succeeded = true;
          setCatalog({ connectionId: selectedConnection, source, models });
        }
      },
      (error: Error) => {
        if (current)
          setCatalog({
            connectionId: selectedConnection,
            source,
            error: error.message,
          });
      },
    );
  }, [selectedConnection, source, catalogRevision, selected?.models]);
  const currentCatalog =
    catalog?.connectionId === selectedConnection && catalog.source === source
      ? catalog
      : undefined;
  const refreshingModels =
    !!selected &&
    (currentCatalog
      ? !currentCatalog.models && !currentCatalog.error
      : !savedModels.length);
  const models = currentCatalog ? currentCatalog.models || [] : savedModels;
  function refreshModels() {
    setCatalog({ connectionId: selectedConnection, source });
    setCatalogRevision((revision) => revision + 1);
  }
  const missingDefinitionModel =
    !!requestedModel && !models.some((m) => m.id === requestedModel);
  const chosen = missingDefinitionModel
    ? ""
    : model
      ? models.find((m) => m.id === model)?.id || ""
      : models.find((m) => ["native-default", "default"].includes(m.id))?.id ||
        models.find((m) => m.effortLevels?.length)?.id ||
        models[0]?.id ||
        "";
  const chosenModel = models.find((m) => m.id === chosen);
  const invalidEffort =
    !!effort &&
    !chosenModel?.effortLevels?.some((level) => level.value === effort);
  const setupSources = sources.filter(
    (item) =>
      item.id &&
      !item.id.startsWith("peer:") &&
      item.id !== executionSourceId(),
  );
  const currentSourceName =
    sources.find((item) => item.id === attachmentSource)?.name ||
    "the original runtime";
  // Uploaded IDs belong to one source, even if the runner changes later.
  const crossSource = attachments.length > 0 && source !== attachmentSource;
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (
      locked.current ||
      !!creationUnavailable ||
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
      folderId: parseId(
        FolderId,
        availableFolders.some((folder) => folder.id === folderChoice)
          ? folderChoice
          : undefined,
      ),
    };

    locked.current = true;
    setBusy(true);
    setError("");
    setUncertain(undefined);
    try {
      // A new suggestion after reload must not abandon an uncertain creation.
      // Only the generated name is retained; free-form inputs stay out of storage.
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify({ ...data, name: nameEdited ? data.name : null }),
        ),
      );
      const signature = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const a = await performStoredEffect(
        localStorage,
        owner,
        source,
        ["agent-create", signature],
        current,
        (idempotencyKey, generatedName) => {
          if (generatedName !== undefined) {
            setSuggestedName(generatedName);
            setTypedName(generatedName);
          }
          return callRoute(
            workspaceApi.agentCreate,
            {
              body: {
                ...data,
                model: parseId(ModelId, data.model),
                attachmentIds: data.attachmentIds.map((id) =>
                  ArtifactId.parse(id),
                ),
                name: generatedName ?? data.name,
                idempotencyKey: IdempotencyKey.parse(idempotencyKey),
              },
            },
            source,
          );
        },
        creationFailureSettled,
        nameEdited ? undefined : data.name,
      );
      if (current()) await onCreated(a, data.folderId || "", source);
    } catch (e) {
      if (current()) {
        setError((e as Error).message);
        setUncertain(e instanceof UncertainEffect ? e : undefined);
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const setupBlock = (
    <details className="runtime-setup-options" open={!connected.length}>
      <summary>Enable an installed agent</summary>
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
                parse<{ authMode?: string; loopHarness?: string }>(
                  c.metadata,
                  {},
                ).loopHarness === runtimeName,
            );
            if (next && !selected) {
              setConnection(connectionKey(next));
            }
            setCatalogRevision((revision) => revision + 1);
          }}
        />
      </div>
    </details>
  );
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
          setNameEdited(true);
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
        <>
          {creationUnavailable && (
            <p role="status" className="field-hint">
              {creationUnavailable}
            </p>
          )}
          <button
            className="primary"
            type="submit"
            form={formId}
            disabled={
              busy ||
              !!creationUnavailable ||
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
        </>
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
      <form id={formId} onSubmit={create} autoComplete="off">
        <label className="create-agent-message">
          <span>
            Opening message <span className="muted">(optional)</span>
          </span>
          <textarea
            {...proseEntry}
            aria-label="Opening message"
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
            capabilities={sourceCapabilities}
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
              ? `These files belong to ${currentSourceName}. Remove them or choose that connection below.`
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
        {loadingName && !name.trim() ? (
          <p className="field-hint" role="status">
            Choosing a name…
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
        {currentCatalog?.error && (
          <div className="error" role="alert">
            Couldn’t refresh models. Try again or choose another connection.
            <button
              type="button"
              className="text-button"
              disabled={busy || uploading}
              onClick={refreshModels}
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
              No models are available. Refresh models or choose another
              connection.
            </p>
          )}
        {!selected && connected.length > 0 && (
          <p className="note" role="status">
            Choose a connected account to start chatting.
          </p>
        )}
        {missingDefinitionModel && !refreshingModels && (
          <p className="error" role="alert">
            The definition requests {requestedModel}, which is unavailable on
            this connection. Choose another model below.
          </p>
        )}
        {model &&
          !chosen &&
          !requestedModel &&
          !refreshingModels &&
          !currentCatalog?.error && (
            <p className="error" role="alert">
              The selected model is no longer available. Choose another model
              below.
            </p>
          )}
        {invalidEffort && !refreshingModels && chosenModel && (
          <p className="error" role="alert">
            This model does not report {effort} effort. Choose a reported effort
            level or the runtime default below.
          </p>
        )}
        {connected.length > 0 && (
          <CreateAgentModelOptions
            connections={connected}
            selected={selected}
            models={models}
            model={chosen}
            effort={effort}
            disabled={busy || uploading}
            refreshing={refreshingModels}
            onConnectionChange={(next) => {
              setConnection(connectionKey(next));
              if ((next.sourceId || "") !== source) setFolderChoice("");
              setModel("");
              setRequestedModel("");
              setEffort("");
              setCatalog(undefined);
              setCatalogRevision(0);
            }}
            onModelChange={(value) => {
              setModel(value);
              setRequestedModel("");
              setEffort("");
            }}
            onEffortChange={setEffort}
            onRefresh={refreshModels}
            onConnect={onConnect}
          >
            {setupSources.map((item) => (
              <button
                type="button"
                className="text-button"
                key={item.id}
                disabled={busy || uploading}
                onClick={() => onSourceSetup?.(item.id)}
              >
                <Plus size={16} /> Connect on {item.name}
              </button>
            ))}
            {setupBlock}
          </CreateAgentModelOptions>
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
                  {...literalEntry}
                  name="agentHandle"
                  aria-label="Unique name"
                  required
                  value={name}
                  onFocus={(e) => {
                    if (nameTouched) return;
                    setTypedName(e.currentTarget.value);
                    setNameTouched(true);
                  }}
                  onChange={(e) => {
                    setNameEdited(
                      e.target.value.trim().toLowerCase() !==
                        suggestedName.trim().toLowerCase(),
                    );
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
                {...proseEntry}
                name="instructions"
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
          </div>
        </details>
        {uncertain && (
          <div role="status">
            <p>
              The earlier chat may already exist. Check your agents before
              starting a separate chat.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                if (locked.current) return;
                locked.current = true;
                setBusy(true);
                try {
                  await uncertain.supersede();
                  if (current()) {
                    setUncertain(undefined);
                    setError("");
                    setNameTouched(false);
                    setNameEdited(false);
                    setTypedName("");
                    setSuggestedName("");
                    setNameRevision((revision) => revision + 1);
                  }
                } catch (error) {
                  if (current()) setError((error as Error).message);
                } finally {
                  locked.current = false;
                  if (mounted.current) setBusy(false);
                }
              }}
            >
              Start a separate chat
            </button>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Sheet>
  );
}
