import { useMemo, type ReactNode } from "react";
import { readDisplaySpec, type DisplayNode } from "../shared/display-spec";
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
};

export function DisplaySpec({
  source,
  compact = false,
  markdown,
}: {
  source: string;
  compact?: boolean;
  markdown: (content: string) => ReactNode;
}) {
  const read = useMemo(() => readDisplaySpec(source), [source]);
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
      <DisplayNodeView node={read.root} context={{ markdown }} level={0} />
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
  return nodes.map((child, index) => (
    <DisplayNodeView
      key={`${index}:${child.key}`}
      node={child}
      context={context}
      level={level + 1}
    />
  ));
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
      // Drawn from the next change on; the reader already validates it.
      return <Placeholder name="Chart" reason="unsupported" />;
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
