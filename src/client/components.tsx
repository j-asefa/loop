import { Chart } from "./Chart";
import { useEffect, useRef, type ReactNode } from "react";
import {
  X,
  Orbit,
  ArrowUpRight,
  MessageSquare,
  Bookmark,
  FolderInput,
  MoreHorizontal,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Artifact, Provider } from "../shared/types";
import { parse } from "./api";
export const providerName = (p?: Provider) =>
  p === "anthropic"
    ? "Anthropic"
    : p === "codex"
      ? "Codex"
      : p === "openai"
        ? "OpenAI"
        : "Loop";
export function Badge({ provider }: { provider?: Provider }) {
  return (
    <span className={"provider " + (provider || "loop")}>
      <span aria-hidden="true">{provider === "anthropic" ? "✳" : "◉"}</span>
      {providerName(provider)}
    </span>
  );
}
export function Avatar({
  name = "Loop",
  provider,
}: {
  name?: string;
  provider?: Provider;
}) {
  return (
    <span className={"avatar " + (provider || "loop")}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="empty">
      <div className="empty-orbit">
        <Orbit size={32} />
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </section>
  );
}
export function Sheet({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    const previous = history.state,
      token = crypto.randomUUID();
    history.pushState({ ...previous, loopDialog: token }, "", location.href);
    const back = () => closeRef.current();
    window.addEventListener("popstate", back);
    return () => {
      d.close();
      window.removeEventListener("popstate", back);
      if (history.state?.loopDialog === token)
        history.replaceState(previous, "", location.href);
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={"sheet " + (wide ? "wide" : "")}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet-inner">
        <div className="sheet-head">
          <h2>{title}</h2>
          <button aria-label="Close" className="icon-button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
export function RichText({ content }: { content: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ alt }) => (
            <span className="note">
              [Image: {alt || "external image"} — open the original source to
              view]
            </span>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
export function ArtifactCard({
  item,
  onOpen,
  onProfile,
  onFile,
  onPin,
  project,
}: {
  item: Artifact;
  project?: string;
  onOpen: () => void;
  onProfile: () => void;
  onFile?: () => void;
  onPin?: () => void;
}) {
  const meta = parse<any>(item.metadata, {});
  return (
    <article className="feed-card">
      <div className="card-byline">
        <button className="identity" onClick={onProfile}>
          <Avatar
            name={item.name || meta.name}
            provider={item.provider || meta.provider}
          />
          <span>
            <strong>
              {item.name || meta.name
                ? "@" + (item.name || meta.name)
                : "Your workspace"}
            </strong>
            <span className="subline">
              <Badge provider={item.provider || meta.provider} />
              <time>
                {new Date(item.created_at).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </time>
            </span>
          </span>
        </button>
        <button
          className="icon-button"
          aria-label="Open output"
          onClick={onOpen}
        >
          <ArrowUpRight size={20} />
        </button>
      </div>
      <button className="card-content" onClick={onOpen}>
        <span className="eyebrow">
          {meta.partial
            ? "Partial output"
            : meta.origin === "import"
              ? "Imported history"
              : item.kind === "workflow"
                ? "Workflow"
                : "Saved automatically"}
        </span>
        {project && <span className="field-hint">{project}</span>}
        <h2>{item.title}</h2>
        <div className="preview">
          {item.kind === "chart" ? (
            <Chart content={item.content} compact />
          ) : (
            <RichText content={item.content.slice(0, 650)} />
          )}
        </div>
      </button>
      <div className="card-actions">
        <button onClick={onOpen}>
          <MessageSquare size={16} />
          Continue
        </button>
        {onFile && (
          <button onClick={onFile}>
            <FolderInput size={16} />
            File
          </button>
        )}
        {onPin && (
          <button
            aria-label={item.pinned ? "Unpin" : "Pin"}
            className={item.pinned ? "active" : ""}
            onClick={onPin}
          >
            <Bookmark size={16} fill={item.pinned ? "currentColor" : "none"} />
          </button>
        )}
        <span className="saved-label">{meta.model || "Private to you"}</span>
      </div>
    </article>
  );
}
