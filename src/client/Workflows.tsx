import { literalEntry, proseEntry } from "./textEntry";
import {
  useSourceId,
  useSourceRoute,
  useProjectionRoute,
} from "./SourceContext";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
import { readRoute } from "./workspace-api";
import { CollectionReadNotice, useCollectionRead } from "./CollectionRead";
import { surfaceFallback } from "./workspace-projections";
import { listenWorkspaceChanges } from "./workspace-changes";
import { useEffect, useRef, useState } from "react";
import { Play, Plus, Check, FileCode, MessageSquare } from "lucide-react";
import { reorderSteps } from "./workflowOrder";
import { parse } from "./api";
import { Sheet, RichText } from "./components";
import type { Agent, Folder } from "../shared/types";
export function starter(agents: Agent[], folder: string) {
  const available = agents.filter((a) => a.connection_id);
  return JSON.stringify(
    {
      dsl: "loop.workflow/v1",
      title: "Research, review, refine",
      inputs: {
        topic: { description: "What should we investigate?", default: "" },
      },
      agents: {
        researcher: available[0]?.id || "CHOOSE_AGENT",
        reviewer: available[1]?.id || available[0]?.id || "CHOOSE_AGENT",
      },
      steps: [
        {
          id: "draft",
          type: "agent",
          agent: "researcher",
          prompt:
            "Research this topic and draft a concise brief. Separate facts from uncertainty. Topic: {{inputs.topic}}",
        },
        {
          id: "review",
          type: "approval",
          source: "draft",
          message: "Review this brief before the next agent refines it.",
        },
        {
          id: "refine",
          type: "agent",
          agent: "reviewer",
          prompt:
            "Critique and improve this brief. Preserve uncertainty and sources:\n{{steps.review}}",
        },
        {
          id: "save",
          type: "save",
          source: "refine",
          title: "Reviewed research brief",
          kind: "markdown",
        },
      ],
      outputs: { brief: "save" },
      folderId: folder || null,
      limits: {
        maxCalls: 2,
        maxOutputTokens: 2048,
        maxInputBytes: 30000,
        maxRunSeconds: 600,
      },
    },
    null,
    2,
  );
}
export function WorkflowEditor({
  agents,
  folders,
  initialId,
  initialSource,
  onClose,
  onStarted,
  onConversation,
  onCreateAgent,
}: {
  agents: Agent[];
  folders: Folder[];
  initialId?: string;
  initialSource?: string;
  onClose: () => void;
  onStarted: () => void;
  onConversation: (id: string) => void;
  onCreateAgent: (source: string, id?: string) => void;
}) {
  const sourceId = useSourceId(),
    call = useSourceRoute(),
    readProjection = useProjectionRoute();
  const [list, setList] = useState<
      RouteResponse<typeof workspaceApi.workflowList>
    >([]),
    [record, setRecord] = useState<RouteResponse<
      typeof workspaceApi.workflowDetail
    > | null>(null),
    [source, setSource] = useState(initialSource || starter(agents, "")),
    [mode, setMode] = useState("preview"),
    [inputs, setInputs] = useState<Record<string, string>>({}),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [selectedRun, setSelectedRun] = useState<string | null>(null),
    [steps, setSteps] = useState<
      RouteResponse<typeof workspaceApi.workflowSteps>
    >([]);
  const recovery = useCollectionRead(JSON.stringify([sourceId, selectedRun]));
  const read = recovery.load;
  const loadSteps = (manual = false, background = false) =>
    selectedRun &&
    read(
      (signal, mode) =>
        readRoute(
          workspaceApi.workflowSteps,
          { params: { id: selectedRun } },
          sourceId,
          signal,
          undefined,
          mode,
        ),
      setSteps,
      manual,
      background,
    );
  const request = useRef({ signature: "", key: "" }),
    spec = parse<any>(source, null);
  async function load(id: string, restoreDraft = false) {
    try {
      const r = await readProjection(workspaceApi.workflowDetail, {
        params: { id },
      });
      setRecord(r);
      setSource(restoreDraft && initialSource ? initialSource : r.source);
      setInputs({});
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void readProjection(workspaceApi.workflowList, {})
      .then(setList)
      .catch((e) => setError(e.message));
    if (initialId) void load(initialId, true);
  }, []);
  useEffect(() => {
    setSteps([]);
    if (!selectedRun) return;
    const update = () => void loadSteps();
    const stopChanges = listenWorkspaceChanges("runs", update, sourceId);
    const stopFallback = surfaceFallback(
      [sourceId],
      "workspace",
      1800,
      () => void loadSteps(false, true),
    );
    void update();
    return () => {
      stopChanges();
      stopFallback();
    };
  }, [selectedRun, sourceId, read]);
  async function save() {
    setBusy(true);
    try {
      const r = await call(workspaceApi.workflowSave, {
        body: {
          source,
          ...(record ? { id: record.id, expectedVersion: record.version } : {}),
        },
      });
      setRecord(
        await readProjection(workspaceApi.workflowDetail, {
          params: { id: r.id },
        }),
      );
      setList(await readProjection(workspaceApi.workflowList, {}));
      setNotice(`Version ${r.version} saved.`);
      setError("");
      return r;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function run() {
    setBusy(true);
    try {
      if (!record || source !== record.source)
        throw new Error("Save this version before running it.");
      const resolved = Object.fromEntries(
        Object.entries(spec.inputs).map(([name, d]: any) => [
          name,
          inputs[name] ?? d.default ?? "",
        ]),
      );
      const signature = JSON.stringify([record.id, record.version, resolved]);
      if (request.current.signature !== signature)
        request.current = { signature, key: crypto.randomUUID() };
      const r = await call(workspaceApi.workflowRun, {
        params: { id: record.id },
        body: {
          version: record.version,
          inputs: resolved,
          idempotencyKey: request.current.key,
        },
      });
      setSelectedRun(r.id);
      setRecord(
        await readProjection(workspaceApi.workflowDetail, {
          params: { id: record.id },
        }),
      );
      onStarted();
      setNotice(
        "Workflow queued. You can close Loop; the server will continue.",
      );
      setError("");
      request.current = { signature: "", key: "" };
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function changeBinding(role: string, value: string) {
    if (spec) {
      spec.agents[role] = value;
      setSource(JSON.stringify(spec, null, 2));
    }
  }
  return (
    <Sheet wide title="Workflows" onClose={onClose}>
      <p className="muted">
        A saved plan, connected agents, and a clear path from idea to output.
      </p>
      <div className="workflow-picker">
        <select
          aria-label="Saved workflow"
          value={record?.id || ""}
          onChange={(e) =>
            e.target.value
              ? void load(e.target.value)
              : (setRecord(null), setSource(starter(agents, "")))
          }
        >
          <option value="">New workflow</option>
          {list.map((w) => (
            <option key={w.id} value={w.id}>
              {w.title} · v{w.version}
            </option>
          ))}
        </select>
        <button
          className="icon-button"
          aria-label="New workflow"
          onClick={() => {
            setRecord(null);
            setSource(starter(agents, ""));
            setInputs({});
          }}
        >
          <Plus size={18} />
        </button>
      </div>
      <div className="segmented">
        <button
          className={mode === "preview" ? "selected" : ""}
          aria-pressed={mode === "preview"}
          onClick={() => setMode("preview")}
        >
          Edit steps
        </button>
        <button
          className={mode === "source" ? "selected" : ""}
          aria-pressed={mode === "source"}
          onClick={() => setMode("source")}
        >
          Advanced JSON
        </button>
      </div>
      {mode === "source" ? (
        <label>
          Loop DSL · loop.workflow/v1
          <textarea
            {...literalEntry}
            className="workflow-source"
            rows={20}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
        </label>
      ) : spec ? (
        <>
          <label>
            Workflow name
            <input
              {...proseEntry}
              value={spec.title || ""}
              onChange={(e) => {
                spec.title = e.target.value;
                setSource(JSON.stringify(spec, null, 2));
              }}
            />
          </label>
          <div className="workflow-steps">
            {spec.steps?.map((s: any, i: number) => (
              <div className="workflow-step" key={s.id}>
                <span className="step-number">{i + 1}</span>
                <div>
                  <strong>
                    {s.type === "agent"
                      ? "Ask an agent"
                      : s.type === "approval"
                        ? "Review before continuing"
                        : "Save output"}
                  </strong>
                  <small>
                    {s.type === "agent"
                      ? `Ask ${s.agent}`
                      : s.type === "approval"
                        ? "Wait for your review"
                        : `Save ${s.source}`}
                  </small>
                </div>
                <span className="status">{s.id}</span>
                <div className="step-order">
                  {[-1, 1].map((direction) => (
                    <button
                      key={direction}
                      className="text-button"
                      aria-label={`Move step ${i + 1} ${direction < 0 ? "up" : "down"}`}
                      disabled={!reorderSteps(spec.steps, i, direction)}
                      title="Steps must follow their input dependencies"
                      onClick={() => {
                        const steps = reorderSteps(spec.steps, i, direction);
                        if (steps) {
                          spec.steps = steps;
                          setSource(JSON.stringify(spec, null, 2));
                        }
                      }}
                    >
                      {direction < 0 ? "Move up" : "Move down"}
                    </button>
                  ))}
                </div>
                <div className="workflow-step-fields">
                  {s.type === "agent" && (
                    <label>
                      Agent role
                      <select
                        value={s.agent}
                        onChange={(e) => {
                          spec.steps[i].agent = e.target.value;
                          setSource(JSON.stringify(spec, null, 2));
                        }}
                      >
                        {Object.keys(spec.agents || {}).map((role) => (
                          <option key={role}>{role}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {(s.type === "agent" || s.type === "approval") && (
                    <label>
                      {s.type === "agent" ? "Prompt" : "Review message"}
                      <textarea
                        {...proseEntry}
                        rows={4}
                        value={
                          (s.type === "agent" ? s.prompt : s.message) || ""
                        }
                        onChange={(e) => {
                          spec.steps[i][
                            s.type === "agent" ? "prompt" : "message"
                          ] = e.target.value;
                          setSource(JSON.stringify(spec, null, 2));
                        }}
                      />
                    </label>
                  )}
                  {s.type === "save" && (
                    <label>
                      Output title
                      <input
                        {...proseEntry}
                        value={s.title || ""}
                        onChange={(e) => {
                          spec.steps[i].title = e.target.value;
                          setSource(JSON.stringify(spec, null, 2));
                        }}
                      />
                    </label>
                  )}
                  {s.source && (
                    <label>
                      Use output from
                      <select
                        value={s.source}
                        onChange={(e) => {
                          spec.steps[i].source = e.target.value;
                          setSource(JSON.stringify(spec, null, 2));
                        }}
                      >
                        {spec.steps
                          .slice(0, i)
                          .map((previous: any, index: number) => (
                            <option key={previous.id} value={previous.id}>
                              Step {index + 1} · {previous.id}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                </div>
              </div>
            ))}
          </div>
          <h3 className="section-title">Participating agents</h3>
          <button onClick={() => onCreateAgent(source, record?.id)}>
            Create an agent for this workflow
          </button>
          {Object.entries(spec.agents || {}).map(([role, a]) => (
            <label key={role}>
              {role}
              <select
                value={String(a)}
                onChange={(e) => changeBinding(role, e.target.value)}
              >
                <option value="CHOOSE_AGENT">Choose an agent</option>
                {agents
                  .filter((a) => a.connection_id)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      @{a.name} · {a.provider} · {a.model}
                    </option>
                  ))}
              </select>
            </label>
          ))}
          <label>
            Save outputs to
            <select
              value={spec.folderId || ""}
              onChange={(e) => {
                spec.folderId = e.target.value || null;
                setSource(JSON.stringify(spec, null, 2));
              }}
            >
              <option value="">Unfiled</option>
              {folders.map((f) => (
                <option value={f.id} key={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <p className="note">
            Usage budget: at most {spec.limits?.maxCalls} agent steps. API
            connections use at most {spec.limits?.maxOutputTokens} output tokens
            per call. Native harnesses enforce the workflow time budget; their
            internal model-call and token counts are controlled by the harness
            and cannot be capped here. Each connection keeps its selected
            billing mode.
          </p>
        </>
      ) : (
        <p className="error">
          Source is not valid JSON. Open Source to fix it.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="note">{notice}</p>}
      <div className="actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={async () => {
            try {
              const r = await call(workspaceApi.workflowValidate, {
                body: { source },
              });
              setNotice(r.notice);
              setError("");
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <Check size={16} />
          Validate
        </button>
        <button className="primary" disabled={busy} onClick={() => void save()}>
          <FileCode size={16} />
          Save {record ? `v${record.version + 1}` : "workflow"}
        </button>
      </div>
      {record && (
        <section className="workflow-run">
          <h3 className="section-title">Run saved version {record.version}</h3>
          {Object.entries(spec?.inputs || {}).map(([name, d]: any) => (
            <label key={name}>
              {d.description || name}
              <textarea
                {...proseEntry}
                rows={2}
                value={inputs[name] ?? d.default ?? ""}
                onChange={(e) =>
                  setInputs({ ...inputs, [name]: e.target.value })
                }
              />
            </label>
          ))}
          <button
            className="primary"
            disabled={busy || source !== record.source}
            onClick={() => void run()}
          >
            <Play size={16} />
            Go for it · v{record.version}
          </button>
          <h3 className="section-title">Run history</h3>
          {record.runs.map((r) => (
            <button
              key={r.id}
              className="search-result"
              onClick={() => setSelectedRun(r.id)}
            >
              <strong>{r.state.replaceAll("_", " ")}</strong>
              <small>
                {" "}
                · {new Date(r.created_at).toLocaleString()} · v
                {parse<any>(r.payload, {}).version}
              </small>
              {r.error && <p className="error">{r.error}</p>}
            </button>
          ))}
          {selectedRun && (
            <div className="workflow-trace">
              <CollectionReadNotice
                {...recovery}
                retry={() => void loadSteps(true)}
              />
              {steps.map((s) => (
                <div key={s.step_id} className="connection-card">
                  <strong>{s.step_id}</strong>
                  <span className="status">{s.child_state || s.state}</span>
                  {s.output && (
                    <details>
                      <summary>Output</summary>
                      <RichText content={s.output} />
                    </details>
                  )}
                  {s.conversation_id && (
                    <button
                      className="text-button"
                      onClick={() => {
                        if (s.conversation_id)
                          onConversation(s.conversation_id);
                      }}
                    >
                      <MessageSquare size={16} />
                      Open agent conversation
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </Sheet>
  );
}
