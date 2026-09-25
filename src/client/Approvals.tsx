import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Clock3,
  Globe,
  ShieldCheck,
  Wrench,
  X,
} from "lucide-react";
import { api, parse } from "./api";
import { Badge, RichText, Sheet } from "./components";
import type { Provider } from "../shared/types";
import { Tools } from "./Tools";

type Approval = {
  id: string;
  run_id: string;
  request: string;
  expires_at: number;
  conversation_id: string | null;
  name: string | null;
  provider: Provider;
  input: string;
};
const label = (value: string) =>
  value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
function describe(a: Approval) {
  const request = parse<any>(a.request, {});
  const title =
    request.type === "mcp_install"
      ? "Install workspace tools"
      : request.type === "workflow_review"
        ? "Review workflow output"
        : request.tool === "browser_navigate"
          ? "Open a webpage"
          : request.tool
            ? label(request.tool)
            : "Review requested action";
  const args =
    request.arguments && typeof request.arguments === "object"
      ? request.arguments
      : {};
  const target = [args.url, args.path, args.command, args.query].find(
    (v) => typeof v === "string",
  );
  return { request, title, args, target };
}

export function Approvals({
  revision,
  teams = "",
  onChange,
  onConversation,
}: {
  revision: number;
  teams?: string;
  onChange: () => void;
  onConversation: (id: string) => void;
}) {
  const [items, setItems] = useState<Approval[]>([]);
  const [selected, setSelected] = useState<Approval | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showTools, setShowTools] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [time, setTime] = useState(Date.now());
  const locked = useRef(false);
  const decided = useRef(new Set<string>());
  useEffect(() => {
    setSelected(null);
    setItems([]);
    setError("");
  }, [teams]);
  useEffect(() => {
    let current = true;
    void api<Approval[]>("/approvals?teams=" + encodeURIComponent(teams))
      .then((fresh) => {
        if (current)
          setItems(fresh.filter((item) => !decided.current.has(item.id)));
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [revision, teams]);
  useEffect(() => {
    if (!selected) return;
    setTime(Date.now());
    const timer = setInterval(() => setTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [selected?.id]);
  const active = selected && items.find((item) => item.id === selected.id);
  const expired = !!selected && selected.expires_at <= time;
  const detail = selected && describe(selected);
  async function decide(decision: "approve" | "reject") {
    if (!selected || !active || expired || locked.current) return;
    locked.current = true;
    setBusy(decision);
    setError("");
    try {
      await api("/approvals/" + selected.id, { decision });
      decided.current.add(selected.id);
      setItems((old) => old.filter((item) => item.id !== selected.id));
      setSelected(null);
      setNotice(
        decision === "approve"
          ? "Approved. The agent can continue."
          : "Request rejected. The action was not run.",
      );
      onChange();
    } catch (e) {
      setError((e as Error).message);
      onChange();
    } finally {
      locked.current = false;
      setBusy(null);
    }
  }
  return (
    <>
      {items.map((item) => {
        const d = describe(item);
        return (
          <article className="approval-card" key={item.id}>
            <button
              className="icon-button approval-dismiss"
              aria-label={`Dismiss approval: ${d.title}`}
              title="Dismiss and cancel this request"
              disabled={!!dismissing || !!busy}
              onClick={async () => {
                if (locked.current) return;
                locked.current = true;
                setDismissing(item.id);
                setError("");
                try {
                  await api(`/runs/${item.run_id}/dismiss`, {});
                  decided.current.add(item.id);
                  setItems((old) => old.filter((a) => a.id !== item.id));
                  setNotice(
                    "Request dismissed and cancelled. Its history is still in the conversation.",
                  );
                  onChange();
                } catch (e) {
                  setError((e as Error).message);
                  onChange();
                } finally {
                  locked.current = false;
                  setDismissing(null);
                }
              }}
            >
              <X size={20} />
            </button>
            <button
              className="approval-summary"
              aria-label={"Review approval: " + d.title}
              onClick={() => {
                setSelected(item);
                setError("");
                setNotice("");
              }}
            >
              <span className="approval-symbol">
                <ShieldCheck size={23} />
              </span>
              <span className="approval-summary-text">
                <span className="eyebrow">Your approval is needed</span>
                <strong>{d.title}</strong>
                <span className="field-hint">
                  {item.name ? "@" + item.name : "Workflow"}
                  {d.request.server ? " · " + d.request.server : ""}
                </span>
                {d.target && (
                  <span className="approval-target-preview">{d.target}</span>
                )}
                <span className="approval-review-link">
                  Review request <ArrowUpRight size={15} />
                </span>
              </span>
            </button>
          </article>
        );
      })}
      {notice && (
        <p className="field-hint" role="status">
          {notice}
        </p>
      )}
      {error && !selected && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {selected && detail && (
        <Sheet title="Review approval" onClose={() => setSelected(null)}>
          <div className="approval-detail">
            <div className="approval-heading">
              <span className="approval-symbol">
                {detail.args.url ? <Globe size={25} /> : <Wrench size={25} />}
              </span>
              <div>
                <span className="eyebrow">
                  {expired
                    ? "Request expired"
                    : active
                      ? "Permission requested"
                      : "Request no longer pending"}
                </span>
                <h3>{detail.title}</h3>
              </div>
            </div>
            <div className="approval-identity">
              <Badge provider={selected.provider} />
              <span>{selected.name ? "@" + selected.name : "Workflow"}</span>
              {detail.request.server && <span>{detail.request.server}</span>}
            </div>
            {detail.request.message && (
              <p className="approval-description">{detail.request.message}</p>
            )}
            {detail.request.tool && (
              <div className="approval-tool">
                <span>Tool</span>
                <code>{detail.request.tool}</code>
              </div>
            )}
            {!!Object.keys(detail.args).length && (
              <dl className="approval-arguments">
                {Object.entries(detail.args).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key.toLowerCase() === "url" ? "URL" : label(key)}</dt>
                    <dd>
                      <pre>
                        {typeof value === "string"
                          ? value
                          : JSON.stringify(value, null, 2)}
                      </pre>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {detail.request.config && (
              <div className="approval-config">
                <h4>Tools to install</h4>
                <pre>{JSON.stringify(detail.request.config, null, 2)}</pre>
              </div>
            )}
            {detail.request.content && (
              <div className="approval-output">
                <RichText content={detail.request.content} />
              </div>
            )}
            {selected.input && (
              <div className="approval-context">
                <span className="field-hint">In response to</span>
                <p>{selected.input}</p>
              </div>
            )}
            <p className="field-hint approval-scope">
              {detail.request.type === "mcp_tool"
                ? "Approves this tool call once. The agent will continue with its result."
                : "The run will continue only after you approve this request."}
            </p>
            {detail.request.type === "mcp_tool" && (
              <button
                className="text-button"
                onClick={() => {
                  setSelected(null);
                  setShowTools(true);
                }}
              >
                Change tool approvals
              </button>
            )}
            <p className="field-hint approval-expiry">
              <Clock3 size={14} />
              {expired ? "Expired " : "Expires "}
              {new Date(selected.expires_at).toLocaleString()}
            </p>
            {selected.conversation_id && (
              <button
                className="text-button"
                onClick={() => {
                  setSelected(null);
                  onConversation(selected.conversation_id!);
                }}
              >
                Open conversation <ArrowUpRight size={15} />
              </button>
            )}
            <details className="approval-technical">
              <summary>Request details</summary>
              <pre>{JSON.stringify(detail.request, null, 2)}</pre>
            </details>
            {(!active || expired) && (
              <p className="note" role="status">
                {expired
                  ? "This request expired. Open the conversation to start a new run after review."
                  : "This request was handled or its run stopped. It cannot be approved again."}
              </p>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="approval-actions">
              <button
                className="primary"
                disabled={!!busy || !active || expired}
                onClick={() => void decide("approve")}
              >
                <Check size={18} />
                {busy === "approve" ? "Approving…" : "Approve and continue"}
              </button>
              <button
                className="secondary"
                disabled={!!busy || !active || expired}
                onClick={() => void decide("reject")}
              >
                <X size={18} />
                {busy === "reject" ? "Rejecting…" : "Reject"}
              </button>
            </div>
          </div>
        </Sheet>
      )}
      {showTools && (
        <Tools
          onClose={() => {
            setShowTools(false);
            onChange();
          }}
        />
      )}
    </>
  );
}
