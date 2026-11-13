import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import createDOMPurify from "dompurify";
import { marked } from "marked";
import { routeUrl, fetchStream } from "./api";
import { workspaceApi } from "../shared/workspace-api";
import { executionSourceId } from "./sourceRouting";
import { Sheet } from "./components";
import type { PullRequestRef } from "../shared/github";
import {
  isRepoPath,
  repoFileKind,
  resolveRepoPath,
} from "../shared/pull-requests";

// A file from a pull request as it is at the head commit, shown the way
// GitHub shows it: Markdown rendered, images and video displayed, other text
// with line numbers. The file is untrusted content from GitHub: Markdown and
// its inline HTML are sanitized, and only files from the same commit load.

const TEXT_CHARS = 400_000;
const encodePath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");

/** The Loop address of a file at a commit, for fetch, <img> and <video>. */
const repoFileUrl = (ref: PullRequestRef, head: string, path: string) =>
  routeUrl(
    workspaceApi.githubPullFile,
    { params: ref, query: { head, path } },
    executionSourceId(),
  );

const githubBlob = (ref: PullRequestRef, head: string, path: string) =>
  `https://github.com/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/blob/${head}/${encodePath(path)}`;

// Roughly the HTML GitHub keeps in rendered Markdown: no scripts, styles,
// forms, frames or event handlers.
const ALLOWED_TAGS = [
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "caption",
  "code",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "li",
  "ol",
  "p",
  "picture",
  "pre",
  "q",
  "s",
  "samp",
  "small",
  "source",
  "span",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "tt",
  "ul",
  "var",
  "video",
];
const ALLOWED_ATTR = [
  "align",
  "alt",
  "checked",
  "colspan",
  "controls",
  "disabled",
  "height",
  "href",
  "open",
  "rowspan",
  "src",
  "start",
  "title",
  "type",
  "width",
];
// A separate instance, so these rules never reach the app's other sanitizing.
// Made on first use: server-side renders have no window.
let purifier: ReturnType<typeof createDOMPurify> | undefined;
const purify = () => (purifier ??= createDOMPurify(window));

const slug = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

/**
 * Markdown rendered and sanitized, with its relative images and video
 * pointed at the same commit. Links to other files keep a data-path for the
 * viewer to open; external images become links, as Loop never loads them.
 */
function renderMarkdown(
  source: string,
  from: string,
  url: (path: string) => string,
  blob: (path: string) => string,
) {
  const fragment = purify().sanitize(
    marked.parse(source, { gfm: true, async: false }) as string,
    { ALLOWED_TAGS, ALLOWED_ATTR, RETURN_DOM_FRAGMENT: true },
  );
  for (const input of fragment.querySelectorAll("input")) {
    if (input.getAttribute("type") !== "checkbox") input.remove();
    else input.setAttribute("disabled", "");
  }
  for (const media of fragment.querySelectorAll("img, video, source")) {
    const src = media.getAttribute("src") || "";
    const target = resolveRepoPath(from, src);
    if (target) {
      media.setAttribute("src", url(target.path));
      if (media.tagName === "IMG") media.setAttribute("loading", "lazy");
      if (media.tagName === "VIDEO") {
        media.setAttribute("controls", "");
        media.setAttribute("playsinline", "");
        media.setAttribute("preload", "metadata");
      }
    } else if (media.tagName === "IMG" && /^https?:\/\//i.test(src)) {
      const link = document.createElement("a");
      link.href = src;
      link.textContent = media.getAttribute("alt") || "External image";
      link.className = "repo-file-external";
      media.replaceWith(link);
    } else media.removeAttribute("src");
  }
  for (const link of fragment.querySelectorAll("a")) {
    const href = link.getAttribute("href") || "";
    if (href.startsWith("#")) continue;
    const target = resolveRepoPath(from, href);
    if (target) {
      link.dataset.path = target.path;
      if (target.hash) link.dataset.hash = target.hash;
      link.href = blob(target.path) + (target.hash ? "#" + target.hash : "");
    } else {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }
  const seen = new Map<string, number>();
  for (const heading of fragment.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const base = slug(heading.textContent || "");
    if (!base) continue;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    heading.id = "user-content-" + (n ? `${base}-${n}` : base);
  }
  return fragment;
}

function Markdown({
  source,
  path,
  url,
  blob,
  onOpen,
}: {
  source: string;
  path: string;
  url: (path: string) => string;
  blob: (path: string) => string;
  onOpen: (path: string, hash?: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.replaceChildren(renderMarkdown(source, path, url, blob));
  }, [source, path]);
  return (
    <div
      ref={ref}
      className="markdown repo-file-markdown"
      onClick={(event) => {
        const link = (event.target as Element).closest?.("a");
        if (!link || !ref.current?.contains(link)) return;
        const href = link.getAttribute("href") || "";
        const hash = href.startsWith("#") ? href.slice(1) : link.dataset.hash;
        if (link.dataset.path && link.dataset.path !== path) {
          event.preventDefault();
          onOpen(link.dataset.path, link.dataset.hash);
        } else if (hash) {
          event.preventDefault();
          scrollToAnchor(ref.current, hash);
        }
      }}
    />
  );
}

function scrollToAnchor(root: HTMLElement | null, hash: string) {
  let id = hash;
  try {
    id = decodeURIComponent(hash);
  } catch {}
  const target =
    root?.querySelector(`[id="user-content-${CSS.escape(id)}"]`) ||
    root?.querySelector(`[id="${CSS.escape(id)}"]`);
  target?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function Code({ text }: { text: string }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <div
      className="repo-file-code"
      role="region"
      aria-label="File contents"
      tabIndex={0}
    >
      <pre>
        {lines.map((line, i) => (
          <span key={i} className="repo-file-line">
            <span className="repo-file-number" aria-hidden="true">
              {i + 1}
            </span>
            {line || " "}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

type Loaded =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "binary" }
  | { state: "text"; text: string; shortened: boolean };

export function RepoFileSheet({
  pullRef,
  headSha,
  path: initial,
  onClose,
}: {
  pullRef: PullRequestRef;
  headSha: string;
  path: string;
  onClose: () => void;
}) {
  // Files opened from links, so Back returns to the one that linked them.
  const [trail, setTrail] = useState<{ path: string; hash?: string }[]>([
    { path: initial },
  ]);
  const { path, hash } = trail[trail.length - 1];
  const kind = isRepoPath(path) ? repoFileKind(path) : undefined;
  const [source, setSource] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const url = (p: string) => repoFileUrl(pullRef, headSha, p);
  const blob = (p: string) => githubBlob(pullRef, headSha, p);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setSource(false);
    if (!kind) {
      setLoaded({ state: "binary" });
      return;
    }
    if (kind === "image" || kind === "video") return;
    let live = true;
    setLoaded({ state: "loading" });
    const controller = new AbortController();
    fetchStream(
      workspaceApi.githubPullFile,
      { params: pullRef, query: { head: headSha, path } },
      executionSourceId(),
      controller.signal,
    )
      .then(async (response) => {
        if (!response.ok) {
          const error = await response.json().catch(() => null);
          throw new Error(
            error?.error || "Couldn’t read this file from GitHub.",
          );
        }
        if (!response.headers.get("content-type")?.startsWith("text/"))
          return { state: "binary" } as const;
        const text = await response.text();
        return {
          state: "text",
          text: text.slice(0, TEXT_CHARS),
          shortened: text.length > TEXT_CHARS,
        } as const;
      })
      .then((result) => live && setLoaded(result))
      .catch(
        (error) =>
          live &&
          setLoaded({
            state: "error",
            message:
              error instanceof TypeError
                ? "Couldn’t reach Loop. Check your connection and try again."
                : error.message,
          }),
      );
    return () => {
      live = false;
      controller.abort();
    };
  }, [path]);
  useEffect(() => {
    if (loaded.state === "text" && hash)
      requestAnimationFrame(() => scrollToAnchor(body.current, hash));
    else body.current?.closest(".sheet-body")?.scrollTo({ top: 0 });
  }, [loaded, hash]);
  const name = path.slice(path.lastIndexOf("/") + 1);
  const folder = path.slice(0, path.length - name.length);
  return (
    <Sheet title={name} wide onClose={onClose} className="repo-file-sheet">
      <div className="repo-file-head">
        {trail.length > 1 && (
          <button
            type="button"
            className="text-button"
            onClick={() => setTrail(trail.slice(0, -1))}
          >
            <ArrowLeft size={16} aria-hidden="true" /> Back
          </button>
        )}
        {/* The title names the file; a folder or a Back trail needs the path. */}
        <code className="repo-file-path">
          {(folder || trail.length > 1) && (
            <>
              <span className="repo-file-dir">{folder}</span>
              {name}
            </>
          )}
        </code>
        <a
          className="text-button"
          href={blob(path)}
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </div>
      {kind === "markdown" && loaded.state === "text" && (
        <div className="chip-row" role="group" aria-label="Show">
          <button
            type="button"
            className="chip"
            aria-pressed={!source}
            onClick={() => setSource(false)}
          >
            Preview
          </button>
          <button
            type="button"
            className="chip"
            aria-pressed={source}
            onClick={() => setSource(true)}
          >
            Code
          </button>
        </div>
      )}
      <div ref={body} className="repo-file-body">
        {kind === "image" ? (
          <img className="repo-file-image" src={url(path)} alt={path} />
        ) : kind === "video" ? (
          <video
            className="repo-file-video"
            src={url(path)}
            controls
            playsInline
            preload="metadata"
          />
        ) : loaded.state === "loading" ? (
          <p className="muted" role="status">
            Reading {name} from GitHub…
          </p>
        ) : loaded.state === "error" ? (
          <p className="error" role="alert">
            {loaded.message}
          </p>
        ) : loaded.state === "binary" ? (
          <p className="field-hint">
            This file can’t be shown here.{" "}
            <a href={blob(path)} target="_blank" rel="noopener noreferrer">
              Open it on GitHub
            </a>
            .
          </p>
        ) : (
          <>
            {kind === "markdown" && !source ? (
              <Markdown
                source={loaded.text}
                path={path}
                url={url}
                blob={blob}
                onOpen={(next, nextHash) =>
                  setTrail([...trail, { path: next, hash: nextHash }])
                }
              />
            ) : (
              <Code text={loaded.text} />
            )}
            {loaded.shortened && (
              <p className="field-hint">
                Only the start of this file is shown.{" "}
                <a href={blob(path)} target="_blank" rel="noopener noreferrer">
                  See all of it on GitHub
                </a>
                .
              </p>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
