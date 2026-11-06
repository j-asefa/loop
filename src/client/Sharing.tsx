import { literalEntry, proseEntry } from "./textEntry";
import { isExecutionRefused } from "./api";
import { useState, useRef, useEffect } from "react";
import { Info, Share, WifiOff } from "lucide-react";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
import {
  useSourceId,
  useSourceRoute,
  useSourceOperation,
} from "./SourceContext";
import { viewGeneration } from "./viewCache";
import { Sheet } from "./components";
import {
  SettingsList,
  SettingsNote,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsSteps,
} from "./SettingsUI";
import type { Agent, Folder, RunView as Run } from "../shared/types";
export type SharedDraft = {
  url: string;
  title: string;
  excerpt: string;
  question: string;
  folderId: string;
};
export function initialShare(): SharedDraft {
  const q = new URLSearchParams(location.search);
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
    : { url: "", title: "", excerpt: "", question: "", folderId: "" };
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
type ShareSheetProps = {
  draft: SharedDraft;
  setDraft: (d: SharedDraft) => void;
  folders: Folder[];
  agents: Agent[];
  newAgentId?: string;
  onCreate: () => void;
  onClose: () => void;
  onSent: (run: Run) => void;
};
export function ShareSheet(props: ShareSheetProps) {
  const source = useSourceId();
  return (
    <ShareForm key={JSON.stringify([source, viewGeneration()])} {...props} />
  );
}
function ShareForm({
  draft,
  setDraft,
  folders,
  agents,
  newAgentId,
  onCreate,
  onClose,
  onSent,
}: ShareSheetProps) {
  const call = useSourceRoute(),
    generation = viewGeneration();
  const previewUnavailable = useSourceOperation(workspaceApi.sharePreview);
  const sendUnavailable = useSourceOperation(workspaceApi.shareSend);
  const createUnavailable = useSourceOperation(workspaceApi.agentCreate);
  const identity = JSON.stringify([draft, newAgentId]);
  const latest = useRef(identity);
  latest.current = identity;
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current?.abort();
    setBusy(false);
    setPreview(null);
    setError("");
    return () => {
      active.current?.abort();
    };
  }, [identity]);
  const begin = () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    return {
      signal: controller.signal,
      current: () =>
        !controller.signal.aborted &&
        latest.current === identity &&
        viewGeneration() === generation,
    };
  };
  const [preview, setPreview] = useState<RouteResponse<
      typeof workspaceApi.sharePreview
    > | null>(null),
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
    if (busy || previewUnavailable) return;
    const request = begin();
    setBusy(true);
    setError("");
    try {
      const result = await call(
        workspaceApi.sharePreview,
        { body: payload },
        request.signal,
      );
      if (request.current()) setPreview(result);
    } catch (e) {
      if (request.current()) setError((e as Error).message);
    } finally {
      if (request.current()) setBusy(false);
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
          {...literalEntry}
          type="url"
          value={draft.url}
          onChange={(e) => update({ url: e.target.value })}
          placeholder="Paste a GitHub repository, X post, or other link"
        />
      </label>
      <label>
        Excerpt or shared text
        <textarea
          {...proseEntry}
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
          {...proseEntry}
          value={draft.question}
          onChange={(e) => update({ question: e.target.value })}
          rows={3}
          placeholder="What could we build with this? Or ask an agent to review it…"
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
      {previewUnavailable && <p className="field-hint">{previewUnavailable}</p>}
      <button
        onClick={review}
        disabled={!draft.question.trim() || busy || !!previewUnavailable}
      >
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
            <button
              className="primary"
              onClick={onCreate}
              disabled={!!createUnavailable}
              title={createUnavailable}
            >
              Choose provider & model
            </button>
          ) : (
            <button
              className="primary"
              disabled={busy || !navigator.onLine || !!sendUnavailable}
              title={sendUnavailable}
              onClick={async () => {
                if (busy || sendUnavailable) return;
                const request = begin();
                setBusy(true);
                try {
                  const body = { ...payload, newAgentId },
                    signature = JSON.stringify(body);
                  if (key.current.signature !== signature)
                    key.current = { signature, key: crypto.randomUUID() };
                  const run = await call(
                    workspaceApi.shareSend,
                    {
                      body: {
                        ...body,
                        idempotencyKey: key.current.key,
                      },
                    },
                    request.signal,
                  );
                  if (request.current()) onSent(run);
                } catch (e) {
                  if (request.current()) {
                    if (isExecutionRefused(e))
                      key.current = { signature: "", key: "" };
                    setError((e as Error).message);
                  }
                } finally {
                  if (request.current()) setBusy(false);
                }
              }}
            >
              Send after review
            </button>
          )}
          {(preview.agent || chosen ? sendUnavailable : createUnavailable) && (
            <p className="field-hint">
              {preview.agent || chosen ? sendUnavailable : createUnavailable}
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}
export function InstallHelp({ onClose }: { onClose: () => void }) {
  const [platform, setPlatform] = useState<"iphone" | "android" | "desktop">(
    /iPhone|iPad|iPod/.test(navigator.userAgent) ? "iphone" : "desktop",
  );
  const [detail, setDetail] = useState("");
  return (
    <Sheet title="Install Loop" onClose={onClose}>
      <p className="settings-intro">Open it from your Home Screen.</p>
      <SettingsSegmented
        label="Platform"
        value={platform}
        onChange={setPlatform}
        options={[
          { id: "iphone", label: "iPhone" },
          { id: "android", label: "Android" },
          { id: "desktop", label: "Desktop" },
        ]}
      />
      {platform === "iphone" ? (
        <SettingsSteps>
          <li>
            <p>Open this Loop address in Safari.</p>
          </li>
          <li>
            <p>Tap Share → Add to Home Screen.</p>
          </li>
          <li>
            <p>Enable Open as Web App when offered, then tap Add.</p>
          </li>
        </SettingsSteps>
      ) : (
        <SettingsSteps>
          <li>
            <p>Open this Loop address in your browser.</p>
          </li>
          <li>
            <p>
              Choose Install app from the address bar or the browser menu.
              <small className="field-hint">
                Browsers supporting Web Share Target can send a URL or text
                straight to the installed Loop app.
              </small>
            </p>
          </li>
        </SettingsSteps>
      )}
      <SettingsNote icon={Info} tone="muted" title="Pair the installed app">
        Open Loop from the new icon. If it asks you to pair, create a new
        pairing link from your workspace. The installed app may need its own
        pairing.
      </SettingsNote>
      <SettingsSection title="Once installed">
        <SettingsList>
          {platform === "iphone" && (
            <SettingsRow
              icon={Share}
              title="Share links into Loop"
              description="Set up the iPhone Shortcut"
              onClick={() => setDetail(detail === "share" ? "" : "share")}
            />
          )}
          <SettingsRow
            icon={WifiOff}
            title="Offline & updates"
            description="What works without a connection"
            onClick={() => setDetail(detail === "offline" ? "" : "offline")}
          />
        </SettingsList>
      </SettingsSection>
      {detail === "share" && (
        <div className="settings-card">
          <h3>Share a link from iPhone</h3>
          <p className="field-hint">
            Use a Shortcut to open a shared link as a Loop draft. Native Web
            Share Target is not assumed on Safari. Accept URLs or Text from the
            Share Sheet, URL Encode the Shortcut Input, build the text below
            with that encoded value, then Open URLs. Loop opens a draft for you
            to review.
          </p>
          <code className="wrap-code">
            {location.origin}/share?text=[URL-encoded Shortcut Input]
          </code>
          <p className="field-hint">
            A shared URL in the text field can be copied into Source URL. You
            can also use /share?url=…&question=… . Opening a link never submits
            work.
          </p>
        </div>
      )}
      {detail === "offline" && (
        <div className="settings-card">
          <h3>Connection &amp; updates</h3>
          <p className="field-hint">
            Active runs continue on the server when you close Loop. New work
            needs a connection. The current screen remains readable offline;
            private history is not stored in the service-worker cache. Save your
            draft before accepting an update.
          </p>
        </div>
      )}
    </Sheet>
  );
}
