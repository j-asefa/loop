import { useMemo, type ReactNode } from "react";
import { readDisplaySpec, type DisplayNode } from "../shared/display-spec";
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
};

// Remark plugin: marks a `spec` fence that has not closed (an answer still
// being written, or text cut short). Markdown parses an open fence as a code
// block running to the end, so only the source span shows whether the
// closing fence arrived.
export function markOpenSpecFences() {
  return (tree: MdNode, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (node: MdNode) => {
      if (node.type === "code" && node.lang === "spec" && node.position) {
        const raw = source.slice(
          node.position.start.offset,
          node.position.end.offset,
        );
        if (!closedFence(raw, node.value ?? ""))
          node.data = {
            ...node.data,
            hProperties: { ...node.data?.hProperties, dataSpecOpen: true },
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

export function DisplaySpec({
  source,
  compact = false,
  open = false,
  writing = false,
  markdown,
}: {
  source: string;
  compact?: boolean;
  // The fence has not closed.
  open?: boolean;
  // The answer is still being written (its run is working).
  writing?: boolean;
  markdown: (content: string) => ReactNode;
}) {
  const live = open && writing;
  const read = useMemo(
    () => readDisplaySpec(source, { open, writing: live }),
    [source, open, live],
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
      <DisplayNodeView
        node={read.root}
        context={{ markdown, compact }}
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
