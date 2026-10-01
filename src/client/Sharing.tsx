import { useState, useRef } from "react";
import { api } from "./api";
import { Sheet } from "./components";
import type { Agent, Folder, Run } from "../shared/types";
export type SharedDraft = {
  url: string;
  title: string;
  excerpt: string;
  question: string;
  folderId: string;
};
export function initialShare(): SharedDraft {
  const q = new URLSearchParams(location.search);
  let stored: any;
  try {
    stored = JSON.parse(sessionStorage.getItem("loop-share") || "null");
  } catch {}
  return q.has("share") || location.pathname === "/share"
    ? {
        url:
          q.get("url") ||
          (q.get("text") || "").trim().match(/^https?:\/\/\S+$/)?.[0] ||
          "",
        title: q.get("title") || "",
        excerpt: q.get("text") || "",
        question: q.get("question") || "",
        folderId: q.get("folder") || "",
      }
    : stored || { url: "", title: "", excerpt: "", question: "", folderId: "" };
}
export function SourceCard({
  source,
}: {
  source: { url: string; title?: string; excerpt?: string };
}) {
  let url: URL;
  try {
    url = new URL(source.url);
    if (!["http:", "https:"].includes(url.protocol)) return null;
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase(),
    label =
      host === "github.com"
        ? "GitHub repository"
        : host === "x.com" || host === "twitter.com"
          ? "X post"
          : host;
  return (
    <aside className="source-card">
      <span className="eyebrow">{label} · Source link</span>
      <a href={url.href} target="_blank" rel="noopener noreferrer">
        {source.title || url.hostname + url.pathname}
      </a>
      {source.excerpt && (
        <blockquote>{source.excerpt.slice(0, 1500)}</blockquote>
      )}
      <small>
        Link only. Loop has not fetched the page; any excerpt was supplied by
        you.
      </small>
    </aside>
  );
}
export function ShareSheet({
  draft,
  setDraft,
  folders,
  agents,
  newAgentId,
  onCreate,
  onClose,
  onSent,
}: {
  draft: SharedDraft;
  setDraft: (d: SharedDraft) => void;
  folders: Folder[];
  agents: Agent[];
  newAgentId?: string;
  onCreate: () => void;
  onClose: () => void;
  onSent: (run: Run) => void;
}) {
  const [preview, setPreview] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const key = useRef({ signature: "", key: "" });
  const chosen = agents.find((a) => a.id === newAgentId);
  function update(p: Partial<SharedDraft>) {
    setDraft({ ...draft, ...p });
    setPreview(null);
  }
  const payload = {
    question: draft.question,
    sharedText: draft.url ? undefined : draft.excerpt,
    source: draft.url
      ? { url: draft.url, title: draft.title, excerpt: draft.excerpt }
      : undefined,
    folderId: draft.folderId || undefined,
  };
  async function review() {
    setError("");
    try {
      setPreview(await api("/share/preview", payload));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Sheet title="Bring it into Loop" onClose={onClose}>
      <p className="muted">
        Share a link, add a question, and give it somewhere to go.
      </p>
      <label>
        Source URL
        <input
          type="url"
          value={draft.url}
          onChange={(e) => update({ url: e.target.value })}
          placeholder="Paste a GitHub repository, X post, or other link"
        />
      </label>
      <label>
        Excerpt or shared text
        <textarea
          value={draft.excerpt}
          onChange={(e) => update({ excerpt: e.target.value })}
          rows={3}
          placeholder="Paste any context your agent should read"
        />
      </label>
      {draft.url && <SourceCard source={draft} />}
      <label>
        Your question
        <textarea
          value={draft.question}
          onChange={(e) => update({ question: e.target.value })}
          rows={3}
          placeholder="What could we build with this? Or @agent-name, review it…"
        />
      </label>
      <label>
        Project
        <select
          value={draft.folderId}
          onChange={(e) => update({ folderId: e.target.value })}
        >
          <option value="">Unfiled</option>
          {folders.map((f) => (
            <option value={f.id} key={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      <p className="field-hint">
        Start with an @handle to queue work for that agent. Without a handle,
        you’ll choose a provider and model for a new agent.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button onClick={review} disabled={!draft.question.trim() || busy}>
        Preview route
      </button>
      {preview && (
        <div className="note">
          <p>
            {preview.agent
              ? `Queue for @${preview.agent.name} · ${preview.agent.provider} · ${preview.agent.model}. Current work will continue.`
              : chosen
                ? `Send to your new agent @${chosen.name} · ${chosen.provider} · ${chosen.model}.`
                : "Create a new agent for this request. Your link, question and project will stay here."}
          </p>
          {!preview.agent && !chosen ? (
            <button className="primary" onClick={onCreate}>
              Choose provider & model
            </button>
          ) : (
            <button
              className="primary"
              disabled={busy || !navigator.onLine}
              onClick={async () => {
                setBusy(true);
                try {
                  const body = { ...payload, newAgentId },
                    signature = JSON.stringify(body);
                  if (key.current.signature !== signature)
                    key.current = { signature, key: crypto.randomUUID() };
                  onSent(
                    await api("/share/send", {
                      ...body,
                      idempotencyKey: key.current.key,
                    }),
                  );
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Send after review
            </button>
          )}
        </div>
      )}
    </Sheet>
  );
}
export function InstallHelp({
  onClose,
  personal = false,
}: {
  onClose: () => void;
  personal?: boolean;
}) {
  return (
    <Sheet title="Loop on your Home Screen" onClose={onClose}>
      <h3>iPhone & iPad</h3>
      <ol>
        <li>Open this Loop address in Safari.</li>
        <li>Tap Share → Add to Home Screen.</li>
        <li>Enable Open as Web App when offered, then tap Add.</li>
        <li>
          {personal
            ? "Launch Loop from the new icon. This personal workspace opens directly; no Loop account is needed."
            : "Launch Loop from the new icon and sign in. Some Safari versions keep app and browser sign-ins separate."}
        </li>
      </ol>
      <h3>Share a link from iPhone</h3>
      <p>
        Use the Shortcut below to open a shared link as a Loop draft. Native Web
        Share Target is not assumed on Safari.
      </p>
      <p>
        For a Shortcut: accept URLs or Text from the Share Sheet, URL Encode the
        Shortcut Input, build the text below with that encoded value, then Open
        URLs. Loop will open a draft for you to review.
      </p>
      <code className="wrap-code">
        {location.origin}/share?text=[URL-encoded Shortcut Input]
      </code>
      <p className="field-hint">
        A shared URL in the text field can be copied into Source URL. You can
        also use /share?url=…&question=… . Opening a link never submits work.
      </p>
      <h3>Android & desktop</h3>
      <p>
        Use your browser’s Install app option. Browsers supporting Web Share
        Target can send URL/text to the installed Loop app.
      </p>
      <h3>Connection & updates</h3>
      <p>
        Active runs continue on the server when you close Loop. New work needs a
        connection. The current screen remains readable offline; private history
        is not stored in the service-worker cache. Save your draft before
        accepting an update.
      </p>
    </Sheet>
  );
}
