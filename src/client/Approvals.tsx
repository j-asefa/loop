import { useSourceApi, useSourceId, useSourceRead } from "./SourceContext";
import { surfaceFallback } from "./workspace-projections";
import { listenWorkspaceChanges } from "./workspace-changes";
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
import { isRateLimited, parse } from "./api";
import { Avatar, Badge, RichText, Sheet } from "./components";
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
// GitHub writes from the official GitHub connection. The approval shows the
// exact target and arguments; the broker refuses merges without a head SHA.
const GITHUB_TITLES: Record<string, string> = {
  pull_request_review_write: "Write a pull request review",
  merge_pull_request: "Merge a pull request",
  create_pull_request: "Open a pull request",
  update_pull_request: "Edit a pull request",
  update_pull_request_branch: "Update a pull request branch",
  add_issue_comment: "Comment on GitHub",
  add_reply_to_pull_request_comment: "Reply to a review comment",
  add_comment_to_pending_review: "Add a review comment",
  push_files: "Push commits to GitHub",
  create_or_update_file: "Commit a file to GitHub",
  delete_file: "Delete a file on GitHub",
  create_branch: "Create a GitHub branch",
};
const ARGUMENT_LABELS: Record<string, string> = {
  body: "Review text",
  event: "Action",
  expectedHeadSha: "Head commit",
  merge_method: "Merge method",
  commit_title: "Commit title",
  commit_message: "Commit message",
};
const label = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (c) => c.toUpperCase());
function describe(a: Approval) {
  const request = parse<any>(a.request, {});
  const args =
    request.arguments && typeof request.arguments === "object"
      ? request.arguments
      : {};
  const title =
    request.type === "mcp_install"
      ? "Install workspace tools"
      : request.type === "workflow_review"
        ? "Review workflow output"
        : request.tool && GITHUB_TITLES[request.tool]
          ? GITHUB_TITLES[request.tool]
          : request.tool === "browser_navigate"
            ? "Open a webpage"
            : request.tool
              ? label(request.tool)
              : "Review requested action";
  const target =
    args.owner && args.repo && (args.pullNumber || args.pull_number)
      ? `${args.owner}/${args.repo} #${args.pullNumber || args.pull_number}`
      : args.owner && args.repo && args.issue_number
        ? `${args.owner}/${args.repo} #${args.issue_number}`
        : request.tool === "create_pull_request" && args.owner && args.repo
          ? `${args.owner}/${args.repo}: ${args.head} → ${args.base}`
          : [args.url, args.path, args.command, args.query].find(
              (v) => typeof v === "string",
            );
  return { request, title, args, target };
}

// One-tap decisions only for requests that need no answers or install review.
function quickDecision(item: Approval) {
  const { request, args } = describe(item);
  return (
    !request.deliveryUnknown &&
    request.type !== "mcp_install" &&
    item.expires_at > Date.now()
  );
}

export function Approvals({
  revision,
  teams = "",
  onChange,
  onConversation,
  runId,
  runIds,
}: {
  revision: number;
  teams?: string;
  onChange: () => void;
  onConversation: (id: string) => void;
  runId?: string;
  runIds?: string[];
}) {
  const api = useSourceApi();
  const sourceId = useSourceId(), read = useSourceRead();
  const [items, setItems] = useState<Approval[]>([]);
  const [selected, setSelected] = useState<Approval | null>(null);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [rateLimited, setRateLimited] = useState(false);
  const [notice, setNotice] = useState("");
  const [showTools, setShowTools] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [time, setTime] = useState(Date.now());
  const locked = useRef(false);
  const decided = useRef(new Set<string>());
  const [poll, setPoll] = useState(0);
  const scope = runIds?.join(",");
  useEffect(() => {
    const update = () => setPoll(value => value + 1);
    const stopChanges = listenWorkspaceChanges("approvals", update, sourceId);
    const stopFallback = runId ? surfaceFallback([sourceId], "workspace", 5000, update) : () => {};
    return () => { stopChanges(); stopFallback(); };
  }, [runId, sourceId]);
  useEffect(() => {
    setSelected(null);
    setItems([]);
    setError("");
    setReadError("");
    setRateLimited(false);
  }, [teams, runId, scope]);
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    void read<Approval[]>("/approvals?teams=" + encodeURIComponent(teams), controller.signal, (error) => {
      if (current) { setRateLimited(isRateLimited(error)); setReadError(isRateLimited(error) ? "" : (error as Error).message); }
    })
      .then((fresh) => {
        if (current) {
          setReadError("");
          setRateLimited(false);
          setItems(
            fresh.filter(
              (item) =>
                !decided.current.has(item.id) &&
                (!runId || item.run_id === runId) &&
                (!runIds || runIds.includes(item.run_id)),
            ),
          );
        }
      })
      .catch((e) => {
        if (current) {
          setRateLimited(isRateLimited(e));
          setReadError(isRateLimited(e) ? "" : e.message);
        }
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [revision, teams, runId, scope, poll]);
  useEffect(() => {
    if (!selected) return;
    setTime(Date.now());
    const timer = setInterval(() => setTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [selected?.id]);
  const active = selected && items.find((item) => item.id === selected.id);
  const expired = !!selected && selected.expires_at <= time;
  const detail = selected && describe(selected);
  async function decide(
    decision: "approve" | "reject",
    target: Approval | null = selected,
  ) {
    const current = target && items.find((item) => item.id === target.id);
    if (
      !target ||
      !current ||
      target.expires_at <= Date.now() ||
      locked.current
    )
      return;
    const detail = describe(target);
    locked.current = true;
    setBusy(decision);
    setError("");
    try {
      await api("/approvals/" + target.id, {
        decision,
        ...(detail.request.deliveryUnknown ? { confirmUnknown: true } : {}),
      });
      decided.current.add(target.id);
      setItems((old) => old.filter((item) => item.id !== target.id));
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
              className="approval-summary"
              aria-label={"Review approval: " + d.title}
              onClick={() => {
                setSelected(item);
                setError("");
                setNotice("");
              }}
            >
              <span className="approval-symbol">
                {item.name ? (
                  <Avatar name={item.name} provider={item.provider} />
                ) : (
                  <ShieldCheck size={23} />
                )}
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
              </span>
            </button>
            <div className="approval-card-actions">
              {quickDecision(item) ? (
                <>
                  <button
                    className="primary"
                    disabled={!!busy || !!dismissing}
                    onClick={() => void decide("approve", item)}
                  >
                    <Check size={17} /> Approve
                  </button>
                  <button
                    className="secondary"
                    disabled={!!busy || !!dismissing}
                    onClick={() => void decide("reject", item)}
                  >
                    <X size={17} /> Deny
                  </button>
                  <button
                    className="text-button"
                    onClick={() => {
                      setSelected(item);
                      setError("");
                      setNotice("");
                    }}
                  >
                    Details
                  </button>
                </>
              ) : (
                <button
                  className="primary"
                  onClick={() => {
                    setSelected(item);
                    setError("");
                    setNotice("");
                  }}
                >
                  Review request <ArrowUpRight size={15} />
                </button>
              )}
            </div>
            <button
              className="text-button approval-dismiss"
              aria-label={`Cancel task: ${d.title}`}
              title="Cancel this task and its pending request"
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
              Cancel task instead
            </button>
          </article>
        );
      })}
      {notice && (
        <p className="field-hint" role="status">
          {notice}
        </p>
      )}
      {rateLimited && (
        <p className="field-hint" role="status">
          Approval updates are paused briefly. Retrying automatically…
        </p>
      )}
      {readError && <p className="error" role="alert">{readError}</p>}
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
            {detail.request.deliveryUnknown && (
              <p role="alert" className="approval-description">
                The previous approval may already have reached the agent. Check
                the native session first. Choosing a decision below explicitly
                retries it once, only if the session still reports this request
                pending.
              </p>
            )}
            {detail.request.message && (
              <p className="approval-description">{detail.request.message}</p>
            )}
            {detail.target && (
              <p className="approval-target">{detail.target}</p>
            )}
            {!!Object.keys(detail.args).length && (
              <dl className="approval-arguments">
                {Object.entries(detail.args)
                  .filter(
                    ([key]) =>
                      !(
                        detail.request.tool === "pull_request_review_write" &&
                        detail.target &&
                        ["owner", "repo", "pullNumber", "pull_number"].includes(
                          key,
                        )
                      ) &&
                      !(key === "url" && detail.target === detail.args.url),
                  )
                  .map(([key, value]) => (
                    <div key={key}>
                      <dt>
                        {key === "body" &&
                        detail.request.tool !== "pull_request_review_write"
                          ? "Text"
                          : ARGUMENT_LABELS[key] ||
                            (key.toLowerCase() === "url" ? "URL" : label(key))}
                      </dt>
                      <dd>
                        <pre>
                          {key === "event" && value === "COMMENT"
                            ? "Post review comments"
                            : key === "event" && value === "APPROVE"
                              ? "Approve the pull request"
                              : key === "event" && value === "REQUEST_CHANGES"
                                ? "Request changes"
                                : typeof value === "string"
                                  ? value
                                  : typeof value === "boolean"
                                    ? value
                                      ? "Yes"
                                      : "No"
                                    : Array.isArray(value) &&
                                        value.every(
                                          (item) => typeof item === "string",
                                        )
                                      ? value.join("\n")
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
              {detail.request.tool === "merge_pull_request" &&
              typeof detail.args.expectedHeadSha === "string"
                ? `Approves this merge once. GitHub merges only if the pull request head is still ${detail.args.expectedHeadSha.slice(0, 7)}; newer commits need a new approval.`
                : detail.request.type === "mcp_tool"
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
          initialView="permissions"
          onClose={() => {
            setShowTools(false);
            onChange();
          }}
        />
      )}
    </>
  );
}
