import { literalEntry } from "./textEntry";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
import { useSourceRoute } from "./SourceContext";
import { useEffect, useState } from "react";
import { Search, Sparkles } from "lucide-react";
import { Sheet } from "./components";
import { SettingsEmpty } from "./SettingsUI";
import type { Agent } from "../shared/types";

type Catalog = RouteResponse<typeof workspaceApi.agentHarness>;
type Configuration = RouteResponse<typeof workspaceApi.agentPiPackages>;
type ConfiguredPackage = Configuration["packages"][number];
type Inspection = RouteResponse<typeof workspaceApi.agentPiInspect>;
type Resource = NonNullable<Catalog["inventory"]>["resources"][number];

export function PiCustomizations({
  agents,
  agentId,
  conversationId,
  mode = "library",
  onClose,
  onUse,
}: {
  agents: Agent[];
  agentId?: string;
  conversationId?: string;
  mode?: "library" | "active";
  onClose: () => void;
  onUse?: (agentId: string, token: string) => void;
}) {
  const route = useSourceRoute();
  const piAgents = agents.filter(
    (agent) => agent.provider === "pi" && !agent.retired_at,
  );
  const [selected, setSelected] = useState(agentId || piAgents[0]?.id || "");
  useEffect(() => {
    if (!selected && piAgents[0]) setSelected(piAgents[0].id);
  }, [selected, piAgents[0]?.id]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<
    "installed" | "discover" | "actions" | "tools" | "instructions"
  >(mode === "active" ? "tools" : "installed");
  const [packagePath, setPackagePath] = useState("");
  const [packages, setPackages] = useState<ConfiguredPackage[]>([]);
  const [configuration, setConfiguration] = useState<Configuration | null>(
    null,
  );
  const [editing, setEditing] = useState<ConfiguredPackage | null>(null);
  const [filters, setFilters] = useState<Record<string, string | undefined>>(
    {},
  );
  const [prompt, setPrompt] = useState<Resource | null>(null);
  const [promptArgs, setPromptArgs] = useState("");
  const [preview, setPreview] = useState<{
    token: string;
    expanded: string;
  } | null>(null);
  const [source, setSource] = useState("");
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [installAnyway, setInstallAnyway] = useState(false);
  const [scope, setScope] = useState<"user" | "project">("user");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    void route(workspaceApi.agentPiPackages, { params: { id: selected } })
      .then((result) => {
        if (active) {
          setPackages(result.packages);
          setConfiguration(result);
        }
      })
      .catch((cause) => active && setError((cause as Error).message));
    return () => {
      active = false;
    };
  }, [selected, refresh]);
  async function decideTrust(trusted: boolean) {
    if (!configuration) return;
    setBusy(true);
    setError("");
    try {
      const result = await route(workspaceApi.agentPiTrust, {
        params: { id: selected },
        body: {
          trusted,
          fingerprint: configuration.trust.fingerprint,
        },
      });
      setConfiguration(result);
      setPackages(result.packages);
      setNotice(
        "Project trust changed. The next Pi turn will start with this decision.",
      );
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function inspectSource() {
    setBusy(true);
    setError("");
    setInspection(null);
    try {
      setInspection(
        await route(workspaceApi.agentPiInspect, {
          params: { id: selected },
          body: {
            source: source.trim(),
          },
        }),
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveFilters() {
    if (!editing) return;
    setBusy(true);
    setError("");
    const next: Record<string, string[]> = {};
    for (const kind of ["extensions", "skills", "prompts", "themes"])
      if (filters[kind] !== undefined)
        next[kind] = filters[kind]!.split(/\r?\n/)
          .map((x) => x.trim())
          .filter(Boolean);
    try {
      const result = await route(workspaceApi.agentPiFilters, {
        params: { id: selected },
        body: {
          source: editing.source,
          scope: editing.scope,
          settingsHash: editing.settingsHash,
          filters: next,
        },
      });
      setConfiguration(result);
      setPackages(result.packages);
      setEditing(null);
      setNotice(
        "Resource selection saved in Pi settings. Start a new Pi session or reload to apply it.",
      );
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function rollbackPackage(pkg: ConfiguredPackage) {
    if (
      !pkg.previousSource ||
      !window.confirm(
        `Restore ${pkg.source} to ${pkg.previousSource}? Pi will apply it to new or reloaded sessions.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const result = await route(workspaceApi.agentPiRollback, {
        params: { id: selected },
        body: { source: pkg.source, scope: pkg.scope },
      });
      setConfiguration(result);
      setPackages(result.packages);
      setNotice(
        "Previous package revision restored. Start a new Pi session or reload to use it.",
      );
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function previewPrompt(resource: Resource) {
    setBusy(true);
    setError("");
    try {
      const result = await route(workspaceApi.agentPiPreview, {
        params: { id: selected },
        body: {
          name: resource.name,
          args: promptArgs,
          ...(conversationId && selected === agentId
            ? { conversation: conversationId }
            : {}),
        },
      });
      setPreview(result);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function packageAction(
    action: "install" | "update" | "remove",
    packageSource: string,
    packageScope: "user" | "project",
  ) {
    if (
      packageScope === "project" &&
      !window.confirm(
        `Pi will read this project's .pi configuration while it ${action}s ${packageSource}. Continue?`,
      )
    )
      return;
    if (
      action === "remove" &&
      packageScope === "user" &&
      !window.confirm(`Remove ${packageSource} from your Pi defaults?`)
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await route(workspaceApi.agentPiAction, {
        params: { id: selected },
        body: { action, source: packageSource, scope: packageScope },
      });
      setPackages(result.packages);
      setConfiguration(result);
      setNotice(
        `Pi ${action} completed. Open a new Pi session or reload Pi to apply the change.`,
      );
      setRefresh((value) => value + 1);
      if (action === "install") {
        setSource("");
        setInspection(null);
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setCatalog(null);
    setError("");
    void route(workspaceApi.agentHarness, {
      params: { id: selected },
      query: {
        conversation:
          conversationId && selected === agentId ? conversationId : undefined,
      },
    })
      .then((result) => active && setCatalog(result))
      .catch((cause) => active && setError((cause as Error).message));
    return () => {
      active = false;
    };
  }, [selected, agentId, conversationId, refresh]);
  const inventory = catalog?.inventory;
  const resources = (inventory?.resources || []).filter(
    (resource) =>
      `${resource.name} ${resource.description} ${resource.package || ""}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (!packagePath || resource.package === packagePath) &&
      (tab === "installed" ||
        tab === "discover" ||
        (tab === "actions"
          ? resource.kind !== "tool"
          : resource.kind === "tool")),
  );
  return (
    <Sheet
      wide
      title={mode === "active" ? "Active in this chat" : "Pi customizations"}
      onClose={onClose}
    >
      <p className="settings-intro">
        Skills, prompts and tools from the computer running this agent.
      </p>
      {piAgents.length > 1 && (
        <label>
          Pi agent
          <select
            value={selected}
            onChange={(event) => {
              setSelected(event.target.value);
              setPackagePath("");
            }}
          >
            {piAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {!selected ? (
        <SettingsEmpty icon={Sparkles} title="No Pi agent yet">
          Run <code>loop</code> or <code>loop pi</code>, then create a Pi agent
          to discover its customizations.
        </SettingsEmpty>
      ) : (
        <>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {!catalog && !error && <p role="status">Loading from Pi…</p>}
          {catalog && !catalog.available && (
            <p className="note">{catalog.message}</p>
          )}
          {catalog?.available && !inventory && (
            <p className="note">
              This Pi runtime did not report a customization inventory. Refresh
              its execution environment and try again.
            </p>
          )}
          {catalog?.available && catalog.message && (
            <p className="note">{catalog.message}</p>
          )}
          {configuration?.trust.required && (
            <section className="pi-resource" aria-label="Project trust">
              <strong>
                Project resources · {configuration.trust.decision}
              </strong>
              <p>
                Pi reads project settings, packages, extensions, skills, and
                prompts only when this project is trusted. Context files may
                still apply.
              </p>
              <small>{configuration.project}</small>
              <ul>
                {configuration.trust.paths.map((item) => (
                  <li key={item.path}>{item.path}</li>
                ))}
              </ul>
              <div className="actions">
                <button disabled={busy} onClick={() => void decideTrust(true)}>
                  Trust project
                </button>
                <button disabled={busy} onClick={() => void decideTrust(false)}>
                  Do not trust
                </button>
              </div>
              <small>
                A changed resource list requires another decision. Idle Pi
                sessions reconnect before the next turn.
              </small>
            </section>
          )}
          {inventory && (
            <div className="pi-inventory-summary">
              <strong>
                {inventory.model?.name || inventory.model?.id || "Pi model"}
              </strong>
              <span>
                {inventory.model?.provider}
                {inventory.thinkingLevel
                  ? ` · ${inventory.thinkingLevel} thinking`
                  : ""}
              </span>
              <small>
                {inventory.packages.length} loaded packages ·{" "}
                {inventory.resources.filter((r) => r.kind === "skill").length}{" "}
                skills ·{" "}
                {inventory.resources.filter((r) => r.kind === "prompt").length}{" "}
                prompts
              </small>
              {configuration?.trust.required &&
                inventory.projectTrusted !== undefined && (
                  <small>
                    Pi session: project resources{" "}
                    {inventory.projectTrusted ? "loaded" : "not trusted"}
                  </small>
                )}
            </div>
          )}
          {inventory?.diagnostics?.length ? (
            <section className="pi-resource" aria-label="Pi load diagnostics">
              <strong>Pi reported extension errors</strong>
              {inventory.diagnostics.map((item, index) => (
                <p key={index}>
                  {item.path || "Extension"}
                  {item.event ? ` · ${item.event}` : ""} failed. Check the Pi
                  process log for details.
                </p>
              ))}
            </section>
          ) : null}
          <div
            className="actions tools-views"
            role="group"
            aria-label="Pi customization view"
          >
            {(
              [
                "installed",
                "discover",
                "actions",
                "tools",
                "instructions",
              ] as const
            ).map((view) => (
              <button
                key={view}
                aria-pressed={tab === view}
                onClick={() => {
                  setTab(view);
                  setPackagePath("");
                }}
              >
                {view === "installed"
                  ? "Installed"
                  : view === "discover"
                    ? "Discover"
                    : view === "actions"
                      ? "Actions"
                      : view === "tools"
                        ? "Agent tools"
                        : "Instructions"}
              </button>
            ))}
          </div>
          {notice && (
            <p className="note" role="status">
              {notice}
            </p>
          )}
          {tab === "discover" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!inspection || inspection.source !== source.trim())
                  void inspectSource();
                else if (inspection.inspected || installAnyway)
                  void packageAction("install", source.trim(), scope);
              }}
            >
              <p className="note">
                Add a Pi package in this agent’s execution environment. Package
                code runs with that computer’s Pi permissions.
              </p>
              <label>
                Package source
                <input
                  {...literalEntry}
                  required
                  value={source}
                  onChange={(event) => {
                    setSource(event.target.value);
                    setInspection(null);
                    setInstallAnyway(false);
                  }}
                  placeholder="npm:@example/pi-tools or git:github.com/org/repo"
                />
              </label>
              <label>
                Install for
                <select
                  value={scope}
                  onChange={(event) =>
                    setScope(event.target.value as "user" | "project")
                  }
                >
                  <option value="user">My Pi defaults</option>
                  <option value="project">This project</option>
                </select>
              </label>
              {inspection && (
                <section
                  className="pi-resource"
                  aria-label="Package inspection"
                >
                  <strong>{inspection.name || inspection.source}</strong>
                  <p>
                    {inspection.description ||
                      inspection.note ||
                      "Package source inspected."}
                  </p>
                  {inspection.resolved && (
                    <small>Resolved: {inspection.resolved}</small>
                  )}
                  {Object.entries(inspection.resources).map(([kind, paths]) => (
                    <div key={kind}>
                      <strong>{kind}</strong>
                      <p>
                        {paths.length
                          ? paths.join(", ")
                          : "None found in the package archive or manifest"}
                      </p>
                    </div>
                  ))}
                  {!inspection.inspected && (
                    <label>
                      <input
                        type="checkbox"
                        checked={installAnyway}
                        onChange={(event) =>
                          setInstallAnyway(event.target.checked)
                        }
                      />{" "}
                      I reviewed this source outside Loop and want Pi to install
                      it
                    </label>
                  )}
                  <small>
                    Inspection lists package files and manifest entries. It does
                    not execute or verify the code.
                  </small>
                </section>
              )}
              <button
                className="primary"
                disabled={
                  busy ||
                  !source.trim() ||
                  (!!inspection && !inspection.inspected && !installAnyway)
                }
              >
                {inspection ? "Install with Pi" : "Review package"}
              </button>
            </form>
          )}
          {tab === "installed" &&
            packages.map((pkg) => (
              <div className="pi-resource" key={`${pkg.scope}:${pkg.source}`}>
                <strong>
                  {pkg.source}{" "}
                  <small>
                    {pkg.scope === "user" ? "My Pi defaults" : "This project"}
                  </small>
                </strong>
                <small>
                  {inventory
                    ? `${inventory.resources.filter((item) => item.source === pkg.source && item.scope === pkg.scope).length} loaded resources reported by this Pi session`
                    : "Live Pi inventory unavailable; loaded state unknown"}
                </small>
                {pkg.resolvedSource && (
                  <small>Installed revision: {pkg.resolvedSource}</small>
                )}
                <p>
                  Configured in Pi settings. Loaded resources appear below after
                  Pi starts or reloads.{" "}
                  {pkg.autoload === false
                    ? "Project filtering overlay; only explicit paths are added to the personal package selection."
                    : Object.keys(pkg.filters || {}).length
                      ? "Resource filters active."
                      : "All declared resources allowed."}
                </p>
                <div className="actions">
                  <button
                    disabled={busy}
                    onClick={() => {
                      setEditing(pkg);
                      setFilters(
                        Object.fromEntries(
                          (
                            [
                              "extensions",
                              "skills",
                              "prompts",
                              "themes",
                            ] as const
                          ).map((kind) => [
                            kind,
                            pkg.filters?.[kind]?.join("\n"),
                          ]),
                        ),
                      );
                    }}
                  >
                    Choose resources
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void packageAction("update", pkg.source, pkg.scope)
                    }
                  >
                    Update
                  </button>
                  {pkg.previousSource && (
                    <button
                      disabled={busy}
                      onClick={() => void rollbackPackage(pkg)}
                    >
                      Restore {pkg.previousSource}
                    </button>
                  )}
                  <button
                    disabled={busy}
                    onClick={() =>
                      void packageAction("remove", pkg.source, pkg.scope)
                    }
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          {tab === "installed" && editing && (
            <section
              className="pi-resource"
              aria-label="Package resource selection"
            >
              <strong>Resources from {editing.source}</strong>
              <p className="field-hint">
                Pi filters can only narrow what the package declares.
              </p>
              <details className="settings-details">
                <summary>How these filters work</summary>
                <p className="field-hint">
                  {editing.autoload === false
                    ? "This project entry is a Pi filtering overlay. Use custom Pi path patterns to add or exclude resources from the personal package selection."
                    : "Leave a type on All to use every resource declared by the package. Select None to disable that type, or enter one Pi path pattern per line. Pi filters cannot add resources the package does not declare."}
                </p>
              </details>
              {(["extensions", "skills", "prompts", "themes"] as const).map(
                (kind) => (
                  <div key={kind}>
                    <label>
                      {kind}
                      <select
                        value={
                          filters[kind] === undefined
                            ? "all"
                            : filters[kind] === ""
                              ? "none"
                              : "custom"
                        }
                        onChange={(event) =>
                          setFilters({
                            ...filters,
                            [kind]:
                              event.target.value === "all"
                                ? undefined
                                : event.target.value === "none"
                                  ? ""
                                  : filters[kind] || "*",
                          })
                        }
                      >
                        <option value="all">All</option>
                        <option value="none">None</option>
                        <option value="custom">Custom paths</option>
                      </select>
                    </label>
                    {filters[kind] !== undefined && filters[kind] !== "" && (
                      <textarea
                        {...literalEntry}
                        aria-label={`${kind} path patterns`}
                        value={filters[kind]}
                        onChange={(event) =>
                          setFilters({ ...filters, [kind]: event.target.value })
                        }
                      />
                    )}
                  </div>
                ),
              )}
              <div className="actions">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void saveFilters()}
                >
                  Save selection
                </button>
                <button onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </section>
          )}
          {tab === "instructions" && (
            <section className="harness-options">
              <p className="note">
                Effective instruction sources for this Pi project. Project
                system files replace personal files with the same role when
                trusted. Context files load separately.
              </p>
              {configuration?.instructions.map((item) => (
                <div className="pi-resource" key={item.path}>
                  <strong>
                    {item.role} ·{" "}
                    {item.effective ? "Applies" : "Overridden or untrusted"}
                  </strong>
                  <p>{item.path}</p>
                  <small>{item.scope}</small>
                </div>
              ))}
              {!configuration?.instructions.length && (
                <p className="note">
                  No instruction files found in Pi’s configured locations.
                </p>
              )}
            </section>
          )}
          {inventory?.toolsTruncated && (
            <p className="note">
              Pi reported more than 150 tools. This view shows the first 150;
              use Pi directly to inspect the rest.
            </p>
          )}
          {tab === "installed" && !!inventory?.packages.length && (
            <div className="pi-package-list">
              {inventory.packages.map((pkg) => (
                <button
                  className="harness-option"
                  key={pkg.path}
                  aria-pressed={packagePath === pkg.path}
                  onClick={() =>
                    setPackagePath(packagePath === pkg.path ? "" : pkg.path)
                  }
                >
                  <strong>
                    {pkg.name} <small>package</small>
                  </strong>
                  <span>
                    {pkg.resources} loaded resources · {pkg.path}
                  </span>
                </button>
              ))}
            </div>
          )}
          {tab !== "discover" && tab !== "instructions" && (
            <label className="directory-search">
              <span className="sr-only">Search Pi customizations</span>
              <Search size={17} aria-hidden="true" />
              <input
                {...literalEntry}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search skills, prompts, commands, tools"
              />
            </label>
          )}
          {packagePath && (
            <button className="text-button" onClick={() => setPackagePath("")}>
              Show all resources
            </button>
          )}
          {tab !== "discover" && tab !== "instructions" && (
            <div className="harness-options">
              {resources.length ? (
                resources.map((resource, index) => (
                  <div
                    className="pi-resource"
                    key={`${resource.kind}:${resource.name}:${index}`}
                  >
                    <strong>
                      {resource.name} <small>{resource.kind}</small>
                    </strong>
                    <p>
                      {resource.description || "No description supplied by Pi."}
                    </p>
                    <small>
                      {resource.scope || "session"}
                      {resource.package
                        ? ` · ${resource.package.split(/[\\/]/).filter(Boolean).at(-1)}`
                        : resource.source
                          ? ` · ${resource.source}`
                          : ""}
                      {resource.kind === "tool"
                        ? resource.active
                          ? " · active"
                          : " · available"
                        : ""}
                    </small>
                    {resource.kind === "extension" && (
                      <small>
                        Mobile compatibility unverified. Terminal-only extension
                        UI may be unavailable in Loop.
                      </small>
                    )}
                    {resource.token && onUse && resource.kind === "prompt" && (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          setPrompt(resource);
                          setPromptArgs("");
                          setPreview(null);
                        }}
                      >
                        Set arguments and preview
                      </button>
                    )}
                    {resource.token && onUse && resource.kind !== "prompt" && (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => onUse(selected, resource.token!)}
                      >
                        Use in chat
                      </button>
                    )}
                  </div>
                ))
              ) : (
                <p className="note">
                  No matching {tab === "tools" ? "agent tools" : "resources"}{" "}
                  reported by Pi.
                </p>
              )}
            </div>
          )}
          {prompt && (
            <section className="pi-resource" aria-label="Prompt preview">
              <strong>/{prompt.name}</strong>
              <p>{prompt.description}</p>
              <label>
                Arguments
                <input
                  {...literalEntry}
                  value={promptArgs}
                  onChange={(event) => {
                    setPromptArgs(event.target.value);
                    setPreview(null);
                  }}
                  placeholder="Optional prompt arguments"
                />
              </label>
              <button
                disabled={busy}
                onClick={() => void previewPrompt(prompt)}
              >
                Preview expanded prompt
              </button>
              {preview && (
                <>
                  <p className="note">
                    Preview using the currently loaded template. Pi expands the
                    command again when you send it.
                  </p>
                  <pre className="pi-prompt-preview">{preview.expanded}</pre>
                  <button
                    className="primary"
                    onClick={() => {
                      onUse?.(selected, preview.token);
                      setPrompt(null);
                    }}
                  >
                    Use in chat
                  </button>
                </>
              )}
              <button className="text-button" onClick={() => setPrompt(null)}>
                Close preview
              </button>
            </section>
          )}
        </>
      )}
      <button
        type="button"
        className="text-button"
        onClick={() => setRefresh((value) => value + 1)}
      >
        Refresh from machine
      </button>
    </Sheet>
  );
}
