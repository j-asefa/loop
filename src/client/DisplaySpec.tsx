import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  isDisplayFenceLanguage,
  readDisplaySpec,
  type DisplayNode,
} from "../shared/display-spec";
import { DisplayChart } from "./DisplayChart";
import "./display.css";

// A fenced `spec` block in an answer, drawn as structured UI. The reader in
// shared/display-spec validates the block; this only draws what it returns.
// Nothing from a spec becomes HTML: every value is a React text child, and
// links are http(s) only.

type Context = {
  // Text content is Markdown, drawn by the caller with displays turned off.
  markdown: (content: string) => ReactNode;
  // Whether a Field sits in a Fields grid, which supplies its <dl>.
  inFields?: boolean;
  // A card preview: charts leave out their table of numbers.
  compact: boolean;
  // Pre-fills the reply composer when a finished display's ReplyButton is clicked.
  onReply: ((prompt: string) => void) | null;
};

// Remark plugin: marks a `spec` fence that has not closed (an answer still
// being written, or text cut short). Markdown parses an open fence as a code
// block. Only an unclosed block at the end of the answer can still grow.
export function markOpenSpecFences({
  previewFenceCut,
  previewEndsAtLine,
  previewFenceIsSpec,
  cappedPreview = false,
}: {
  previewFenceCut?: boolean;
  previewEndsAtLine?: boolean;
  previewFenceIsSpec?: boolean;
  cappedPreview?: boolean;
} = {}) {
  return (tree: MdNode, file: { value: unknown }) => {
    const source = String(file.value);
    let lastContent = source.length;
    while (lastContent > 0 && " \t\r\n".includes(source[lastContent - 1]))
      lastContent--;
    const visit = (node: MdNode) => {
      if (
        previewFenceIsSpec &&
        node.type === "code" &&
        node.position?.end.offset === source.length &&
        node.value === "" &&
        !/[\r\n]/.test(source.slice(node.position.start.offset))
      )
        node.lang = "spec";
      if (
        node.type === "code" &&
        isDisplayFenceLanguage(node.lang) &&
        node.position
      ) {
        const raw = source.slice(
          node.position.start.offset,
          node.position.end.offset,
        );
        const cut =
          previewFenceCut && node.position.end.offset === source.length;
        if (
          ((cut && !previewFenceIsSpec) ||
            (cappedPreview &&
              previewFenceCut === undefined &&
              node.position.end.offset === source.length)) &&
          !/[\r\n]/.test(raw)
        ) {
          // The prefix of an ordinary language tag can look like "spec".
          node.lang = "text";
          return;
        }
        const hasCloser = closedFence(raw, node.value ?? "");
        const open = cut || !hasCloser;
        const atEnd = (node.position.end.offset ?? 0) >= lastContent;
        // A newline after a parsed closer proves its line was fully captured.
        // A closer at the exact cutoff may still be a prefix of a longer line.
        const atPreviewEnd =
          cappedPreview &&
          atEnd &&
          (open ||
            (previewFenceCut !== false &&
              !/^[ \t]*[\r\n]/.test(source.slice(node.position.end.offset))));
        if (open || atPreviewEnd)
          node.data = {
            ...node.data,
            hProperties: {
              ...node.data?.hProperties,
              dataSpecOpen: open,
              dataSpecCanGrow: open && atEnd,
              dataSpecAtPreviewEnd: atPreviewEnd,
              dataSpecLineMayContinue:
                (open || atPreviewEnd) &&
                atEnd &&
                !hasCloser &&
                !previewEndsAtLine &&
                !/[\r\n][ \t]*$/.test(source),
            },
          };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
type MdNode = {
  type: string;
  lang?: string | null;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
  children?: MdNode[];
};
// The parser includes literal fence-like lines in its code value and
// excludes the real closer. Compare line counts so indentation is interpreted
// by Markdown, including inside list items and quotes.
function closedFence(raw: string, value: string) {
  const lines = raw.split(/\r\n?|\n/);
  if (lines.length < 2) return false;
  const open = /^(`{3,}|~{3,})/.exec(raw)?.[1];
  const close = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/.exec(lines.at(-1)!)?.[1];
  return (
    !!open &&
    !!close &&
    close[0] === open[0] &&
    close.length >= open.length &&
    (value === "" || value.split(/\r\n?|\n/).length < lines.length - 1)
  );
}

export const DisplayWritingContext = createContext(false);
export const DisplayReplyContext = createContext<
  ((prompt: string) => void) | null
>(null);

export function DisplaySpec({
  source,
  compact = false,
  open = false,
  canGrow = false,
  omitSource = false,
  lineMayContinue = false,
  markdown,
}: {
  source: string;
  compact?: boolean;
  // The fence has not closed.
  open?: boolean;
  canGrow?: boolean;
  omitSource?: boolean;
  lineMayContinue?: boolean;
  markdown: (content: string) => ReactNode;
}) {
  const writing = useContext(DisplayWritingContext);
  const reply = useContext(DisplayReplyContext);
  const live = open && canGrow && writing;
  const incomplete = live || omitSource;
  const onReply = !compact && !writing && !open && !omitSource ? reply : null;
  const read = useMemo(
    () =>
      readDisplaySpec(source, {
        open: open || omitSource,
        writing: incomplete,
        finalLineIncomplete: incomplete && lineMayContinue,
      }),
    [source, open, omitSource, incomplete, lineMayContinue],
  );
  // While written, a block with no root element yet shows a short line, not
  // its source; a finished answer never does.
  if (
    !read.ok &&
    live &&
    (read.reason === "empty" ||
      read.reason === "no_root" ||
      read.reason === "missing_root")
  )
    return (
      <p className="note display-loading" role="status">
        Display loading…
      </p>
    );
  if (!read.ok && live)
    return <p className="note">This display could not be drawn yet.</p>;
  if (!read.ok && omitSource)
    return <p className="note">Open the conversation to see this display.</p>;
  if (!read.ok) {
    const shown = source.replace(/\n$/, "");
    return (
      <>
        <p className="note">
          This display could not be drawn. Its source is below.
        </p>
        <pre>
          <code className="language-spec">
            {/* Card previews cut source to 10 lines, as for other code. */}
            {compact ? shown.split("\n").slice(0, 10).join("\n") : shown}
          </code>
        </pre>
      </>
    );
  }
  return (
    <div className="display-spec">
      {open && !live && !omitSource && read.skippedCount > 0 && (
        <p className="note">Some display updates could not be applied.</p>
      )}
      <DisplayNodeView
        node={read.root}
        context={{ markdown, compact, onReply }}
        level={0}
      />
    </div>
  );
}

function Children({
  nodes,
  context,
  level,
}: {
  nodes: DisplayNode[];
  context: Context;
  level: number;
}) {
  // Keys come from element keys, so a display that grows while it is
  // written keeps every drawn element in place. A key listed twice is
  // told apart by how many times it appeared before.
  const seen = new Map<string, number>();
  return nodes.map((child) => {
    const occurrence = seen.get(child.key) ?? 0;
    seen.set(child.key, occurrence + 1);
    return (
      <DisplayNodeView
        key={`${child.key}#${occurrence}`}
        node={child}
        context={context}
        level={level + 1}
      />
    );
  });
}

function DisplayNodeView({
  node,
  context,
  level,
}: {
  node: DisplayNode;
  context: Context;
  level: number;
}) {
  const plain = { ...context, inFields: false };
  switch (node.type) {
    case "Card": {
      const Heading = level === 0 ? "h3" : "h4";
      return (
        <section className="display-card" aria-label={node.title || undefined}>
          {(node.title || node.subtitle) && (
            <div>
              {node.title && (
                <Heading className="display-title">{node.title}</Heading>
              )}
              {node.subtitle && (
                <p className="display-subtitle">{node.subtitle}</p>
              )}
            </div>
          )}
          <Children nodes={node.children} context={plain} level={level} />
        </section>
      );
    }
    case "Section":
      return (
        <div className="display-section">
          <Children nodes={node.children} context={plain} level={level} />
        </div>
      );
    case "Text":
      return (
        <div className={`display-text display-text-${node.style}`}>
          {context.markdown(node.content)}
        </div>
      );
    case "Fields":
      return (
        <dl className="display-fields">
          <Children
            nodes={node.children}
            context={{ ...context, inFields: true }}
            level={level}
          />
        </dl>
      );
    case "Field": {
      const pair = (
        <div className="display-field">
          <dt>{node.label}</dt>
          <dd>{node.value}</dd>
        </div>
      );
      return context.inFields ? (
        pair
      ) : (
        <dl className="display-fields">{pair}</dl>
      );
    }
    case "Table":
      return (
        <div
          className="table-scroll"
          role="region"
          aria-label={node.caption || "Table"}
          tabIndex={0}
        >
          <table>
            {node.caption && <caption>{node.caption}</caption>}
            <thead>
              <tr>
                {node.headers.map((header, i) => (
                  <th key={i} scope="col" className={`align-${node.align[i]}`}>
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className={`align-${node.align[c]}`}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "Chart":
      return (
        <DisplayChart
          title={node.title}
          chart={node.chart}
          compact={context.compact}
        />
      );
    case "Divider":
      return <hr className="display-divider" />;
    case "Actions":
      return (
        <div className="display-actions">
          <Children nodes={node.children} context={plain} level={level} />
        </div>
      );
    case "LinkButton":
      return (
        <a
          className="display-link-button"
          href={node.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {node.label}
        </a>
      );
    case "ReplyButton": {
      const prompt = node.prompt ?? node.label;
      const onReply = context.onReply;
      return (
        <button
          type="button"
          className="display-reply-button"
          disabled={!onReply}
          title={
            onReply
              ? node.prompt && node.prompt !== node.label
                ? node.prompt
                : undefined
              : "Open the conversation to reply"
          }
          onClick={onReply ? () => onReply(prompt) : undefined}
        >
          {node.label}
        </button>
      );
    }
    case "Placeholder":
      return <Placeholder name={node.name} reason={node.reason} />;
  }
}

function Placeholder({
  name,
  reason,
}: {
  name: string;
  reason: "unsupported" | "invalid";
}) {
  return (
    <p className="display-placeholder" role="note">
      {reason === "unsupported"
        ? `${name} is not supported here`
        : "This part of the display could not be shown"}
    </p>
  );
}
