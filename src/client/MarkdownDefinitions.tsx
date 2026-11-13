import {
  ConnectionId,
  FolderId,
  TeamId,
  parseId,
} from "../shared/contract-ids.js";
import { literalEntry, proseEntry } from "./textEntry";
import { workspaceApi } from "../shared/workspace-api";
import { callRoute, readRoute } from "./api";
import { useEffect, useRef, useState } from "react";
import { parse } from "./json";
import { Sheet } from "./components";
import { viewOwner } from "./viewCache";
import {
  DEFINITION_EXAMPLES,
  MAX_DEFINITION_BYTES,
  type AgentDefinition,
  type DefinitionCreation,
  type DefinitionSummary,
} from "../shared/agent-definitions";
import type { Connection, Folder } from "../shared/types";
import type { ModelOption } from "../shared/models";

export function MarkdownDefinitions({
  kind,
  sourceId,
  onClose,
  onUse,
}: {
  kind: "agent" | "team";
  sourceId: string;
  onClose: () => void;
  onUse: (definition: AgentDefinition) => void;
}) {
  const [items, setItems] = useState<DefinitionSummary[]>();
  const [editing, setEditing] = useState<{
    id: string;
    version: number;
    markdown: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const locked = useRef(false);
  const alive = useRef(true);
  const currentSource = useRef(sourceId);
  currentSource.current = sourceId;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const owner = viewOwner();
    readRoute(
      workspaceApi.definitionList,
      {},
      sourceId,
      controller.signal,
      (failure) => {
        // Keep refresh failures visible while the bounded GET recovery runs;
        // a successful save/delete remains authoritative during that wait.
        if (!controller.signal.aborted && owner === viewOwner())
          setError((failure as Error).message);
      },
    )
      .then((rows) => {
        if (!controller.signal.aborted && owner === viewOwner()) {
          setItems(rows);
          setError("");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted && owner === viewOwner()) {
          setError(e.message);
        }
      });
    return () => controller.abort();
  }, [sourceId, revision]);
  const reads = useRef(new Set<AbortController>());
  useEffect(
    () => () => {
      for (const controller of reads.current) controller.abort();
    },
    [sourceId],
  );
  async function readDefinition(id: string) {
    const controller = new AbortController();
    reads.current.add(controller);
    try {
      return await readRoute(
        workspaceApi.definitionRead,
        { params: { id } },
        sourceId,
        controller.signal,
      );
    } finally {
      controller.abort();
      reads.current.delete(controller);
    }
  }
  async function action(work: () => Promise<() => void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const owner = viewOwner();
    try {
      const apply = await work();
      if (
        alive.current &&
        owner === viewOwner() &&
        currentSource.current === sourceId
      )
        apply();
    } catch (e) {
      if (alive.current && owner === viewOwner())
        setError((e as Error).message);
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function download(item: AgentDefinition) {
    const url = URL.createObjectURL(
      new Blob([item.markdown], { type: "text/markdown;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${item.name.replace(/[^a-z0-9-]/gi, "-") || "definition"}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <Sheet
      title={editing ? "Edit Markdown definition" : "Markdown definitions"}
      dismissible={!busy}
      onClose={
        editing
          ? () => {
              setEditing(undefined);
              setError("");
            }
          : onClose
      }
    >
      <p className="muted">
        Save reusable {kind} definitions in this Loop workspace. Editing or
        deleting a definition leaves agents already created from it unchanged.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              const saved = await callRoute(
                workspaceApi.definitionSave,
                {
                  params: { id: editing.id },
                  body: {
                    markdown: editing.markdown,
                    version: editing.version,
                    kind,
                  },
                },
                sourceId,
              );
              return () => {
                const { markdown: _markdown, spec: _spec, ...summary } = saved;
                setItems((rows) => [
                  summary,
                  ...(rows || []).filter((row) => row.id !== saved.id),
                ]);
                setEditing(undefined);
                setRevision((value) => value + 1);
              };
            });
          }}
        >
          <fieldset disabled={busy}>
            <label>
              Import Markdown file
              <input
                type="file"
                accept=".md,.markdown,text/markdown,text/plain"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (!file) return;
                  void action(async () => {
                    if (file.size > MAX_DEFINITION_BYTES)
                      throw new Error(
                        "Markdown definitions must be at most 128 KB",
                      );
                    const markdown = await file.text();
                    return () => setEditing({ ...editing, markdown });
                  });
                }}
              />
            </label>
            <label>
              Markdown definition
              <textarea
                {...literalEntry}
                aria-label="Markdown definition"
                rows={18}
                value={editing.markdown}
                maxLength={MAX_DEFINITION_BYTES}
                onChange={(event) =>
                  setEditing({ ...editing, markdown: event.target.value })
                }
              />
            </label>
            <p className="field-hint">
              Use YAML frontmatter for the name, description and optional model
              or effort.{" "}
              {kind === "team"
                ? "Define a manager and 1–8 members with their own instructions; the Markdown body adds guidance for everyone."
                : "The Markdown body becomes the agent’s instructions."}{" "}
              Connections are chosen when creating agents. Harness-specific
              tools, hooks and permission settings are not supported.
            </p>
            <button className="primary" disabled={!editing.markdown.trim()}>
              {busy ? "Saving…" : "Save definition"}
            </button>
          </fieldset>
        </form>
      ) : (
        <>
          <button
            className="primary"
            disabled={busy || !items}
            onClick={() => {
              setError("");
              setEditing({
                id: crypto.randomUUID(),
                version: 0,
                markdown: DEFINITION_EXAMPLES[kind],
              });
            }}
          >
            New {kind} definition
          </button>
          {!items && !error && (
            <p className="muted" role="status">
              Loading definitions…
            </p>
          )}
          {items && !items.some((item) => item.kind === kind) && (
            <p className="muted">
              No saved {kind} definitions yet. Start with an example or import a
              Markdown file.
            </p>
          )}
          {items
            ?.filter((item) => item.kind === kind)
            .map((item) => (
              <section key={item.id} className="team-directory-item">
                <strong style={{ overflowWrap: "anywhere" }}>
                  {item.name}
                </strong>
                {item.description && <p>{item.description}</p>}
                <div className="actions">
                  <button
                    aria-label={`Use ${item.name}`}
                    disabled={busy}
                    className="primary"
                    onClick={() =>
                      void action(async () => {
                        const definition = await readDefinition(item.id);
                        if (definition.kind !== kind)
                          throw new Error(
                            "The definition type changed. Reload the library.",
                          );
                        return () => onUse(definition);
                      })
                    }
                  >
                    Use
                  </button>
                  <button
                    aria-label={`Edit ${item.name}`}
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const definition = await readDefinition(item.id);
                        return () => setEditing(definition);
                      })
                    }
                  >
                    Edit
                  </button>
                  <button
                    aria-label={`Download ${item.name}`}
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const definition = await readDefinition(item.id);
                        return () => download(definition);
                      })
                    }
                  >
                    Download
                  </button>
                  <button
                    aria-label={`Delete ${item.name}`}
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        try {
                          await callRoute(
                            workspaceApi.definitionDelete,
                            {
                              params: { id: item.id },
                              body: { version: item.version },
                            },
                            sourceId,
                          );
                        } catch (error) {
                          const failure = error as Error & { status?: number };
                          // A retry after a lost success response already has
                          // the requested outcome. Keep source errors visible.
                          if (
                            failure.status !== 404 ||
                            failure.message !== "Definition not found"
                          )
                            throw error;
                        }
                        return () => {
                          setItems((rows) =>
                            rows?.filter((row) => row.id !== item.id),
                          );
                          setRevision((value) => value + 1);
                        };
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              </section>
            ))}
          {error && (
            <button
              disabled={busy}
              onClick={() => {
                setError("");
                setRevision((value) => value + 1);
              }}
            >
              Reload definitions
            </button>
          )}
        </>
      )}
    </Sheet>
  );
}

type RoleChoice = {
  name: string;
  connectionId: ConnectionId;
  model: string;
  effort: string | null;
};
export function CreateFromDefinition({
  definition,
  sourceId,
  connections,
  folders,
  initialFolder,
  teamId,
  onClose,
  onCreated,
}: {
  definition: AgentDefinition;
  sourceId: string;
  connections: Connection[];
  folders: Folder[];
  initialFolder?: string;
  teamId?: string;
  onClose: () => void;
  onCreated: (result: DefinitionCreation) => void;
}) {
  const spec = definition.spec;
  const roles = spec.kind === "team" ? [spec.manager, ...spec.members] : [spec];
  const available = connections.filter((c) => c.status === "connected");
  const native = (connectionId: string) =>
    !!parse<{ loopHarness?: string }>(
      available.find((c) => c.id === connectionId)?.metadata,
      {},
    ).loopHarness;
  type Catalog = { models?: ModelOption[]; error?: string };
  const [catalogState, setCatalogState] = useState<{
    key: string;
    entries: Record<string, Catalog>;
  }>({ key: "", entries: {} });
  const [catalogRevision, setCatalogRevision] = useState(0);
  // Native choices start empty until discovery returns. Explicit models from
  // the definition stay selected so an unavailable request cannot fall back.
  const storedModels = (connectionId: string) =>
    native(connectionId)
      ? []
      : parse<ModelOption[]>(
          available.find((c) => c.id === connectionId)?.models,
          [],
        );
  const [choices, setChoices] = useState<Record<string, RoleChoice>>(() =>
    Object.fromEntries(
      roles.map((role) => [
        role.name,
        {
          name: role.name,
          connectionId: parseId(ConnectionId, available[0]?.id || ""),
          model:
            role.model && role.model !== "inherit"
              ? role.model
              : storedModels(available[0]?.id || "")[0]?.id || "",
          effort: role.effort || null,
        },
      ]),
    ),
  );
  const [name, setName] = useState(spec.name);
  const [folderId, setFolderId] = useState(initialFolder || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const receipt = useRef({ body: "", key: "" });
  const alive = useRef(true);
  const currentSource = useRef(sourceId);
  currentSource.current = sourceId;
  const nativeIds = JSON.stringify(
    [...new Set(Object.values(choices).map((c) => c.connectionId))]
      .filter(native)
      .sort(),
  );
  const catalogKey = JSON.stringify([sourceId, catalogRevision]);
  const catalogs = catalogState.key === catalogKey ? catalogState.entries : {};
  const models = (connectionId: string) =>
    native(connectionId)
      ? catalogs[connectionId]?.models || []
      : storedModels(connectionId);
  useEffect(() => {
    const controller = new AbortController();
    const owner = viewOwner();
    // A role changing connection must not invalidate the other roles' loaded
    // catalogs. An explicit refresh or workspace change still reloads them.
    const cached = catalogState.key === catalogKey ? catalogState.entries : {};
    setCatalogState((current) =>
      current.key === catalogKey ? current : { key: catalogKey, entries: {} },
    );
    for (const connectionId of JSON.parse(nativeIds) as string[]) {
      if (cached[connectionId]) continue;
      void callRoute(
        workspaceApi.connectionModels,
        { params: { id: ConnectionId.parse(connectionId) } },
        sourceId,
        controller.signal,
      ).then(
        ({ models: discovered }) => {
          if (controller.signal.aborted || owner !== viewOwner()) return;
          setCatalogState((current) => ({
            key: catalogKey,
            entries: {
              ...current.entries,
              [connectionId]: { models: discovered },
            },
          }));
          setChoices((current) =>
            Object.fromEntries(
              Object.entries(current).map(([role, choice]) => [
                role,
                choice.connectionId === connectionId && !choice.model
                  ? { ...choice, model: discovered[0]?.id || "" }
                  : choice,
              ]),
            ),
          );
        },
        (error: Error) => {
          if (controller.signal.aborted || owner !== viewOwner()) return;
          setCatalogState((current) => ({
            key: catalogKey,
            entries: {
              ...current.entries,
              [connectionId]: { error: error.message },
            },
          }));
        },
      );
    }
    return () => controller.abort();
  }, [catalogKey, nativeIds, sourceId]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const valid = roles.every((role) => {
    const chosen = choices[role.name];
    const model = models(chosen.connectionId).find(
      (m) => m.id === chosen.model,
    );
    return (
      chosen.name &&
      model &&
      (!chosen.effort ||
        model.effortLevels?.some((e) => e.value === chosen.effort))
    );
  });
  return (
    <Sheet
      title={
        teamId
          ? "Create a worker from Markdown"
          : `Create ${spec.kind} from Markdown`
      }
      onClose={onClose}
      dismissible={!busy}
    >
      <p>{spec.description || spec.name}</p>
      <p className="muted">
        Loop saves these agents with their own settings. Work starts when you
        send a message.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (locked.current || !valid) return;
          locked.current = true;
          setBusy(true);
          setError("");
          const owner = viewOwner();
          const body = {
            version: definition.version,
            name,
            folderId: parseId(FolderId, folderId || null),
            teamId: parseId(TeamId, teamId),
            selection: {
              connectionId: parseId(
                ConnectionId,
                choices[roles[0].name].connectionId,
              ),
            },
            roles: choices,
          };
          const encoded = JSON.stringify({
            sourceId,
            definitionId: definition.id,
            ...body,
          });
          if (receipt.current.body !== encoded)
            receipt.current = { body: encoded, key: crypto.randomUUID() };
          try {
            const result = await callRoute(
              workspaceApi.definitionCreate,
              {
                params: { id: definition.id },
                body: { ...body, idempotencyKey: receipt.current.key },
              },
              sourceId,
            );
            if (
              alive.current &&
              owner === viewOwner() &&
              currentSource.current === sourceId
            )
              onCreated(result);
          } catch (e) {
            if (alive.current && owner === viewOwner())
              setError((e as Error).message);
          } finally {
            locked.current = false;
            if (alive.current) setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          {spec.kind === "team" && (
            <label>
              Team name
              <input
                {...proseEntry}
                value={name}
                maxLength={80}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}
          <label>
            Project
            <select
              aria-label="Project"
              value={folderId}
              onChange={(event) => setFolderId(event.target.value)}
            >
              <option value="">Workspace</option>
              {folders
                .filter((folder) => !folder.is_workspace)
                .map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
            </select>
          </label>
          {roles.map((role, index) => {
            const chosen = choices[role.name],
              catalog = models(chosen.connectionId);
            const model = catalog.find((m) => m.id === chosen.model);
            const discovery = catalogs[chosen.connectionId];
            const refreshing =
              native(chosen.connectionId) &&
              !discovery?.models &&
              !discovery?.error;
            const change = (patch: Partial<RoleChoice>) =>
              setChoices((values) => ({
                ...values,
                [role.name]: { ...values[role.name], ...patch },
              }));
            const label =
              spec.kind === "agent"
                ? "Agent"
                : index === 0
                  ? "Manager"
                  : `Worker ${index}`;
            return (
              <fieldset key={role.name}>
                <legend>
                  {label} · {role.name}
                </legend>
                <label>
                  {label} name
                  <input
                    {...literalEntry}
                    required
                    maxLength={32}
                    pattern="[a-zA-Z][a-zA-Z0-9-]{2,31}"
                    value={chosen.name}
                    onChange={(event) => change({ name: event.target.value })}
                  />
                </label>
                <label>
                  {label} connection
                  <select
                    aria-label={`${label} connection`}
                    value={chosen.connectionId}
                    onChange={(event) => {
                      const connectionId = event.target.value;
                      change({
                        connectionId: parseId(ConnectionId, connectionId),
                        model: models(connectionId)[0]?.id || "",
                        effort: null,
                      });
                    }}
                  >
                    <option value="">Choose a connection</option>
                    {available.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {label} model
                  <select
                    aria-label={`${label} model`}
                    value={chosen.model}
                    disabled={refreshing}
                    onChange={(event) =>
                      change({ model: event.target.value, effort: null })
                    }
                  >
                    {!model && (
                      <option value={chosen.model} disabled>
                        {refreshing
                          ? "Loading models…"
                          : chosen.model
                            ? `${chosen.model} — unavailable; choose a model`
                            : "Choose a model"}
                      </option>
                    )}
                    {catalog.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name || m.id}
                      </option>
                    ))}
                  </select>
                </label>
                {discovery?.error && (
                  <p className="error" role="alert">
                    Could not refresh {label.toLowerCase()} models.{" "}
                    {discovery.error}
                  </p>
                )}
                {(model?.effortLevels?.length || chosen.effort) && (
                  <label>
                    {label} effort
                    <select
                      aria-label={`${label} effort`}
                      value={chosen.effort || ""}
                      onChange={(event) =>
                        change({ effort: event.target.value || null })
                      }
                    >
                      <option value="">Default</option>
                      {chosen.effort &&
                        !model?.effortLevels?.some(
                          (e) => e.value === chosen.effort,
                        ) && (
                          <option value={chosen.effort}>{chosen.effort}</option>
                        )}
                      {model?.effortLevels?.map((e) => (
                        <option key={e.value} value={e.value}>
                          {e.value}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <details>
                  <summary>{label} instructions</summary>
                  <p
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {role.instructions}
                  </p>
                </details>
              </fieldset>
            );
          })}
          {!valid && (
            <p className="field-hint">
              Choose an available model and effort for every agent.
            </p>
          )}
          {Object.values(choices).some(
            (choice) => catalogs[choice.connectionId]?.error,
          ) && (
            <button
              type="button"
              onClick={() => setCatalogRevision((value) => value + 1)}
            >
              Refresh models
            </button>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={!valid}>
            {busy
              ? "Creating…"
              : teamId
                ? "Create worker"
                : `Create ${spec.kind}`}
          </button>
        </fieldset>
      </form>
    </Sheet>
  );
}
