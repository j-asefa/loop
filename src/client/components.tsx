import { Chart } from "./Chart";
import { Diagram } from "./Diagram";
import { PullRequestCards, pullRequestCardData } from "./PullRequestCard";
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import {
  X,
  Orbit,
  ArrowUpRight,
  MessageSquare,
  Bookmark,
  FolderInput,
  MoreHorizontal,
  Archive,
  AlarmClock,
} from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Artifact, Connection, Provider } from "../shared/types";
import { parse } from "./api";
import { runModelName } from "./modelChoices";
import { RunStatus } from "./RunStatus";
import { useSheetDrag } from "./useSheetDrag";
import { registerSheet } from "./sheetHistory";
import { ActionSheet, useLongPress, useSwipe } from "./ThreadTools";
import { FileLink, loopFileUrl } from "./FilePreview";
import {
  browserPreview,
  compactMarkdown,
  safePreviewLink,
  structuredPreview,
  webPreview,
} from "./preview";
export const providerName = (p?: Provider) =>
  p === "acp"
    ? "ACP agent"
    : p === "pi"
      ? "Pi"
      : p === "opencode"
        ? "OpenCode"
        : p === "anthropic"
          ? "Claude"
          : p === "codex"
            ? "ChatGPT"
            : p === "openai"
              ? "OpenAI API"
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
  // Local, deterministic avatars remain recognizable without network requests.
  let seed = 2166136261;
  for (const c of name.toLowerCase())
    seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0;
  const hue = seed % 360;
  return (
    <span className="avatar generated" role="img" aria-label={name + " avatar"}>
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <rect
          width="40"
          height="40"
          rx="12"
          fill={"hsl(" + hue + " 55% 85%)"}
        />
        <path
          d={
            seed % 2 ? "M5 40V22Q5 6 20 6T35 22V40" : "M4 40V20Q20 -6 36 20V40"
          }
          fill={"hsl(" + hue + " 45% 40%)"}
        />
        <rect
          x="9"
          y="15"
          width="22"
          height="15"
          rx={(seed % 6) + 3}
          fill={"hsl(" + hue + " 70% 95%)"}
        />
        <circle cx="15" cy="21" r="2" fill="#243331" />
        <circle cx="25" cy="21" r="2" fill="#243331" />
        <path
          d={seed % 3 ? "M17 26Q20 29 23 26" : "M17 27H23"}
          fill="none"
          stroke="#243331"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
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
// Open sheets in the order they opened: the last one is on top (the most
// recent modal dialog), whatever its place in the document.
const openSheets: HTMLDialogElement[] = [];
/** The topmost open sheet: the only part of the page not made inert. */
export const topSheet = () => openSheets.at(-1) || null;

export function Sheet({
  title,
  heading,
  children,
  onClose,
  wide = false,
  titleRef,
  swipeToClose = false,
  className = "",
}: {
  title: string;
  heading?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  titleRef?: Ref<HTMLHeadingElement>;
  swipeToClose?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useSheetDrag(ref, swipeToClose, closeRef);
  useEffect(() => {
    const d = ref.current!;
    // Return focus to what opened the sheet when it closes. The dialog is
    // removed with the component, so the browser cannot restore it.
    const opener = document.activeElement as HTMLElement | null;
    d.showModal();
    openSheets.push(d);
    const unregister = registerSheet(() => closeRef.current());
    return () => {
      d.close();
      const index = openSheets.indexOf(d);
      if (index >= 0) openSheets.splice(index, 1);
      unregister();
      // Only when nothing else took over: no other sheet, or the opener is
      // inside the sheet still open beneath this one.
      if (
        opener?.isConnected &&
        (!document.querySelector("dialog[open]") ||
          opener.closest("dialog[open]"))
      )
        opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={
        "sheet " +
        (wide ? "wide " : "") +
        (swipeToClose ? "swipe-sheet " : "") +
        className
      }
      onCancel={(e) => {
        // React passes a nested sheet's Escape up to the sheets around it;
        // only the sheet that was cancelled closes.
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {swipeToClose && (
        <button
          type="button"
          className="sheet-grip"
          aria-label="Close conversation"
          title="Drag down to close"
          onClick={onClose}
        >
          <span />
        </button>
      )}
      <div className="sheet-inner">
        <div className="sheet-head">
          {heading || (
            <h2 ref={titleRef} tabIndex={titleRef ? -1 : undefined}>
              {title}
            </h2>
          )}
          <button
            type="button"
            aria-label="Close"
            className="icon-button"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </dialog>
  );
}
export function RichText({
  content,
  diagrams = true,
  compact = false,
}: {
  content: string;
  diagrams?: boolean;
  compact?: boolean;
}) {
  // Preserve table scroll positions and open file previews during refreshes.
  const renderers = useMemo<Components>(
    () => ({
      table: ({ children }) => (
        <div
          className="table-scroll"
          role="region"
          aria-label="Table"
          tabIndex={0}
        >
          <table>{children}</table>
        </div>
      ),
      pre: ({ children, node }) => {
        const code = node?.children[0] as any;
        if (
          diagrams &&
          code?.tagName === "code" &&
          code.properties?.className?.includes("language-mermaid")
        )
          return (
            <Diagram
              compact={compact}
              source={code.children
                .map((c: any) => c.value || "")
                .join("")
                .trim()}
            />
          );
        return <pre>{children}</pre>;
      },
      a: ({ children, href }) => {
        const file = loopFileUrl(href);
        return file ? (
          <FileLink url={file}>{children}</FileLink>
        ) : (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
      img: ({ alt, src }) => {
        const file = loopFileUrl(src);
        return file ? (
          <FileLink url={file} name={alt || "Image preview"}>
            {alt || "View image"}
          </FileLink>
        ) : (
          <span className="note">
            [Image: {alt || "external image"} — open the original source to
            view]
          </span>
        );
      },
    }),
    [diagrams, compact],
  );
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={compact ? [remarkGfm, compactMarkdown] : [remarkGfm]}
        components={renderers}
      >
        {content}
      </Markdown>
    </div>
  );
}
const previewValue = (v: unknown) =>
  typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "—");
function DataPreview({ value }: { value: any }) {
  if (value && Array.isArray(value.columns) && Array.isArray(value.rows))
    return (
      <div className="table-scroll">
        <table className="preview-table">
          <thead>
            <tr>
              {value.columns.slice(0, 6).map((c: unknown, i: number) => (
                <th key={i}>{previewValue(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {value.rows
              .slice(0, 4)
              .filter(Array.isArray)
              .map((row: any[], i: number) => (
                <tr key={i}>
                  {row.slice(0, 6).map((v, j) => (
                    <td key={j}>{previewValue(v)}</td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    );
  if (Array.isArray(value))
    return value.length ? (
      <ul className="structured-preview">
        {value.slice(0, 5).map((row, i) => {
          if (!row || typeof row !== "object")
            return <li key={i}>{previewValue(row)}</li>;
          const href = safePreviewLink(row.url || row.link);
          const title =
            row.title || row.name || (href && new URL(href).hostname);
          return (
            <li key={i}>
              {title ? (
                <>
                  <strong>
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {previewValue(title)}
                      </a>
                    ) : (
                      previewValue(title)
                    )}
                  </strong>
                  {(row.description || row.details || row.snippet) && (
                    <span>
                      {previewValue(
                        row.description || row.details || row.snippet,
                      )}
                    </span>
                  )}
                </>
              ) : (
                <DataPreview value={row} />
              )}
            </li>
          );
        })}
      </ul>
    ) : (
      <p className="muted">No items returned.</p>
    );
  if (value && typeof value === "object")
    return (
      <dl className="preview-properties">
        {Object.entries(value)
          .slice(0, 5)
          .map(([key, v]) => (
            <div key={key}>
              <dt>{key.replaceAll("_", " ")}</dt>
              <dd>{previewValue(v)}</dd>
            </div>
          ))}
      </dl>
    );
  return <p>{previewValue(value)}</p>;
}
function ArtifactPreview({
  item,
  tool,
  web,
}: {
  item: Artifact;
  tool?: string;
  web?: ReturnType<typeof webPreview>;
}) {
  const metadata = parse<any>(item.metadata, {});
  if (
    metadata.uploaded &&
    ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
      metadata.mime,
    )
  )
    return (
      <img
        className="preview-image"
        src={`/api/artifacts/${item.id}/file?preview=1`}
        alt={metadata.name || item.title}
        loading="lazy"
      />
    );
  if (web)
    return (
      <div className="web-preview">
        {web.pages.map((page) => (
          <div key={page.url}>
            {web.search && (
              <a
                className="web-result-title"
                href={page.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {page.title}
              </a>
            )}
            <a
              className="web-result-source"
              href={page.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {new URL(page.url).hostname.replace(/^www\./, "")}{" "}
              <ArrowUpRight size={12} />
            </a>
            {page.excerpt && <p>{page.excerpt}</p>}
          </div>
        ))}
      </div>
    );
  if (item.kind === "diagram") return <Diagram source={item.content} compact />;
  if (item.kind === "chart") return <Chart content={item.content} compact />;
  if (item.kind === "github_pr") {
    const card = pullRequestCardData(item.content);
    if (card) return <PullRequestCards card={card} compact />;
  }
  if (item.kind === "code")
    return (
      <pre className="code-preview">
        <code>
          {item.content.split("\n").slice(0, 8).join("\n").slice(0, 4000)}
        </code>
      </pre>
    );
  if (item.kind === "image") {
    const bitmap = parse<any>(item.content, null);
    return bitmap &&
      ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        bitmap.mimeType,
      ) &&
      typeof bitmap.data === "string" &&
      /^[a-zA-Z0-9+/=]+$/.test(bitmap.data) ? (
      <img
        className="preview-image"
        src={`data:${bitmap.mimeType};base64,${bitmap.data}`}
        alt={item.title}
      />
    ) : (
      <p>Open this image to view it.</p>
    );
  }
  const value = structuredPreview(item.content);
  if (value !== undefined) return <DataPreview value={value} />;
  const browser = tool?.startsWith("browser_") && browserPreview(item.content);
  if (browser)
    return (
      <div className="browser-preview">
        <strong>{browser.title}</strong>
        <a href={browser.url} target="_blank" rel="noopener noreferrer">
          {new URL(browser.url).hostname}
        </a>
        <span>Browser activity saved. Open the output for details.</span>
      </div>
    );
  // Very large tool logs get a plain-text excerpt, never broken Markdown.
  if (item.content.length > 30000)
    return <p className="plain-preview">{item.content.slice(0, 1200)}…</p>;
  return <RichText content={item.content} compact />;
}
export function ArtifactCard({
  item,
  connections,
  onOpen,
  onProfile,
  onFile,
  onPin,
  onArchive,
  onArtifact,
  onReply,
  onLater,
  project,
  model,
  className,
  label,
  headerActions,
  footer,
  detail,
}: {
  item: Artifact;
  connections: Connection[];
  project?: string;
  model?: string;
  onOpen: () => void;
  onProfile: () => void;
  onFile?: () => void;
  onPin?: () => void;
  onArchive?: () => void;
  onArtifact?: () => void;
  onReply?: () => void;
  onLater?: () => void;
  className?: string;
  label?: string;
  headerActions?: ReactNode;
  footer?: ReactNode;
  detail?: ReactNode;
}) {
  const meta = parse<any>(item.metadata, {});
  const modelName = model || runModelName(meta, connections);
  const web = webPreview(
    item.content,
    meta.tool ||
      (item.title.endsWith(" result") ? item.title.slice(0, -7) : undefined),
  );
  const [menu, setMenu] = useState(false);
  const open = onArtifact || onOpen;
  // Swipe left archives (with Undo), swipe right saves; long-press opens the
  // full menu. Nothing destructive happens on a press alone.
  const swipe = useSwipe({ onLeft: onArchive, onRight: onPin });
  const press = useLongPress(() => setMenu(true), !footer);
  const merged = (name: string) => (e: any) => {
    (swipe.handlers as any)[name]?.(e);
    (press as any)[name]?.(e);
  };
  return (
    <div
      className={
        "card-swipe" +
        (swipe.armed ? " armed-" + swipe.armed : "") +
        (swipe.offset ? " swiping" : "")
      }
    >
      {onPin && (
        <span className="swipe-under left" aria-hidden="true">
          <Bookmark size={20} /> {item.pinned ? "Unsave" : "Save"}
        </span>
      )}
      {onArchive && (
        <span className="swipe-under right" aria-hidden="true">
          <Archive size={20} /> Archive
        </span>
      )}
      <article
        className={["feed-card", className].filter(Boolean).join(" ")}
        style={
          swipe.offset
            ? { transform: `translateX(${swipe.offset}px)` }
            : undefined
        }
        onPointerDown={merged("onPointerDown")}
        onPointerMove={merged("onPointerMove")}
        onPointerUp={merged("onPointerUp")}
        onPointerCancel={merged("onPointerCancel")}
        onPointerLeave={(press as any).onPointerLeave}
        onContextMenu={(press as any).onContextMenu}
        onClickCapture={merged("onClickCapture")}
      >
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
                {modelName && <span className="card-model">{modelName}</span>}
                <time>
                  {new Date(item.created_at).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}{" "}
                  ·{" "}
                  {new Date(item.created_at).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </time>
              </span>
            </span>
          </button>
          {headerActions}
          {!footer && (
            <button
              className="icon-button"
              aria-label="More actions"
              onClick={() => setMenu(true)}
            >
              <MoreHorizontal size={20} />
            </button>
          )}
        </div>
        <div
          className="card-content"
          role="button"
          tabIndex={0}
          aria-label={"Open " + item.title}
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest("a,button,summary,input"))
              open();
          }}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && ["Enter", " "].includes(e.key)) {
              e.preventDefault();
              open();
            }
          }}
        >
          <span className="eyebrow">
            {label ||
              (meta.partial
                ? "Partial output"
                : meta.origin === "import"
                  ? "Imported history"
                  : web
                    ? web.search
                      ? "Web search"
                      : "Webpage"
                    : meta.tool
                      ? "Tool result"
                      : item.kind === "workflow"
                        ? "Workflow"
                        : "Result")}
            {project && <span className="card-project"> · {project}</span>}
          </span>
          {className?.includes("run-card") ? (
            <div className="run-prompt">
              <RichText content={item.title} compact />
            </div>
          ) : (
            <h2>
              {web
                ? web.title
                : meta.tool && item.title === `${meta.tool} result`
                  ? meta.tool.startsWith("browser_")
                    ? "Browser result"
                    : meta.tool.replaceAll("_", " ") + " result"
                  : item.title}
            </h2>
          )}
          <RunStatus
            state={item.run_state}
            error={item.run_error}
            empty={!item.content}
          />
          {detail}
          <div className="preview">
            <ArtifactPreview item={item} tool={meta.tool} web={web} />
          </div>
          {!!item.content && (
            <button className="text-button preview-open" onClick={open}>
              View full result <ArrowUpRight size={14} />
            </button>
          )}
        </div>
        {footer || (
          <div className="card-actions">
            <button onClick={onReply || open}>
              <MessageSquare size={16} />
              Reply
            </button>
            {onPin && (
              <button
                aria-label={item.pinned ? "Remove from Saved" : "Save"}
                className={item.pinned ? "active" : ""}
                onClick={onPin}
              >
                <Bookmark
                  size={16}
                  fill={item.pinned ? "currentColor" : "none"}
                />
                {item.pinned ? "Saved" : "Save"}
              </button>
            )}
            {onLater && (
              <button onClick={onLater}>
                <AlarmClock size={16} />
                Remind me
              </button>
            )}
            {onFile && (
              <button onClick={onFile}>
                <FolderInput size={16} />
                File
              </button>
            )}
          </div>
        )}
      </article>
      {menu && (
        <ActionSheet
          title={item.title}
          onClose={() => setMenu(false)}
          actions={[
            {
              id: "open",
              label: "Open",
              icon: <ArrowUpRight size={20} />,
              onSelect: open,
            },
            ...(onReply
              ? [
                  {
                    id: "reply",
                    label: "Reply in thread",
                    icon: <MessageSquare size={20} />,
                    onSelect: onReply,
                  },
                ]
              : []),
            ...(onPin
              ? [
                  {
                    id: "save",
                    label: item.pinned ? "Remove from Saved" : "Save",
                    icon: <Bookmark size={20} />,
                    onSelect: onPin,
                  },
                ]
              : []),
            ...(onLater
              ? [
                  {
                    id: "later",
                    label: "Remind me",
                    icon: <AlarmClock size={20} />,
                    onSelect: onLater,
                  },
                ]
              : []),
            ...(onFile
              ? [
                  {
                    id: "file",
                    label: "File into a project",
                    icon: <FolderInput size={20} />,
                    onSelect: onFile,
                  },
                ]
              : []),
            ...(onArchive
              ? [
                  {
                    id: "archive",
                    label: "Archive",
                    hint: "Stays in history and search",
                    icon: <Archive size={20} />,
                    onSelect: onArchive,
                  },
                ]
              : []),
          ]}
        />
      )}
    </div>
  );
}
