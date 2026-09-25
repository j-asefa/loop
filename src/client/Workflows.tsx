import { useEffect, useRef, useState } from "react";
import {
  Play,
  Plus,
  Check,
  ArrowDown,
  FileCode,
  MessageSquare,
  GitBranch,
} from "lucide-react";
import { api, parse } from "./api";
import { Sheet, Badge, RichText, Empty } from "./components";
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
  const [list, setList] = useState<any[]>([]),
    [record, setRecord] = useState<any>(null),
    [source, setSource] = useState(initialSource || starter(agents, "")),
    [mode, setMode] = useState("preview"),
    [inputs, setInputs] = useState<Record<string, string>>({}),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [selectedRun, setSelectedRun] = useState<string | null>(null),
    [steps, setSteps] = useState<any[]>([]);
  const request = useRef({ signature: "", key: "" }),
    spec = parse<any>(source, null);
  async function load(id: string, restoreDraft = false) {
    try {
      const r = await api("/workflows/" + id);
      setRecord(r);
      setSource(restoreDraft && initialSource ? initialSource : r.source);
      setInputs({});
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void api("/workflows").then(setList);
    if (initialId) void load(initialId, true);
  }, []);
  useEffect(() => {
    if (!selectedRun) return;
    const update = () =>
      api<any[]>("/runs/" + selectedRun + "/steps").then(setSteps);
    void update();
    const timer = setInterval(() => void update(), 1800);
    return () => clearInterval(timer);
  }, [selectedRun]);
  async function save() {
    setBusy(true);
    try {
      const r = await api("/workflows", {
        source,
        ...(record ? { id: record.id, expectedVersion: record.version } : {}),
      });
      setRecord(await api("/workflows/" + r.id));
      setList(await api("/workflows"));
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
      const r = await api(`/workflows/${record.id}/run`, {
        version: record.version,
        inputs: resolved,
        idempotencyKey: request.current.key,
      });
      setSelectedRun(r.id);
      setRecord(await api("/workflows/" + record.id));
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
    <Sheet wide title="Executable workflows" onClose={onClose}>
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
          onClick={() => setMode("preview")}
        >
          Preview
        </button>
        <button
          className={mode === "source" ? "selected" : ""}
          onClick={() => setMode("source")}
        >
          Source
        </button>
      </div>
      {mode === "source" ? (
        <label>
          Loop DSL · loop.workflow/v1
          <textarea
            className="workflow-source"
            rows={20}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            spellCheck={false}
          />
        </label>
      ) : spec ? (
        <>
          <h3 className="section-title">{spec.title}</h3>
          <div className="workflow-steps">
            {spec.steps?.map((s: any, i: number) => (
              <div className="workflow-step" key={s.id}>
                <span className="step-number">{i + 1}</span>
                <div>
                  <strong>{s.id}</strong>
                  <small>
                    {s.type === "agent"
                      ? `Ask ${s.agent}`
                      : s.type === "approval"
                        ? "Wait for your review"
                        : `Save ${s.source}`}
                  </small>
                </div>
                <span className="status">{s.type}</span>
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
              <option value="">Workspace inbox</option>
              {folders.map((f) => (
                <option value={f.id} key={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <p className="note">
            Usage budget: at most {spec.limits?.maxCalls} model calls;{" "}
            {spec.limits?.maxOutputTokens} output tokens per call. Provider API
            charges apply.
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
              const r = await api("/workflows/validate", { source });
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
          {record.runs?.map((r: any) => (
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
                      onClick={() => onConversation(s.conversation_id)}
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
