import { parse } from "./json";
import { RichText } from "./components";
import { codexToolApproval } from "../shared/codex-approval";

export function NativeRequestDetails({
  request,
}: {
  request: { detail?: string };
}) {
  const structured = parse<{
    command?: unknown;
    input?: { command?: unknown };
  } | null>(request.detail, null);
  const toolApproval = codexToolApproval(structured);
  // Claude nests the shell command in its tool input.
  const command = structured?.command ?? structured?.input?.command;
  const detail = command
    ? typeof command === "string"
      ? command
      : JSON.stringify(command)
    : request.detail;
  return (
    <>
      <div
        className="native-decision-detail"
        role="region"
        aria-label="Request details"
        tabIndex={0}
      >
        {toolApproval ? (
          <>
            <p>
              {toolApproval.server}
              {toolApproval.tool ? ` · ${toolApproval.tool}` : ""}
            </p>
            <RichText content={toolApproval.message} />
            {toolApproval.arguments !== undefined && (
              <>
                <h4>Tool arguments</h4>
                <pre>{JSON.stringify(toolApproval.arguments, null, 2)}</pre>
              </>
            )}
          </>
        ) : structured && !command ? (
          // Structured requests are data, not Markdown: indented JSON would
          // otherwise become unwrapped code blocks.
          <pre>{JSON.stringify(structured, null, 2)}</pre>
        ) : (
          <RichText content={detail || ""} />
        )}
      </div>
      {!!(command || toolApproval) && (
        <details>
          <summary>Native request details</summary>
          <pre>{JSON.stringify(structured, null, 2)}</pre>
        </details>
      )}
    </>
  );
}
