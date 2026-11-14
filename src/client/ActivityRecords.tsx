import { assertNever } from "../shared/assert-never";
import type { ActivityRecord } from "../shared/agent-activities";
import { outputText } from "../shared/agent-activities";
import {
  PlanPanel,
  FileChangePanel,
  CommandOutputPanel,
} from "./ActivityPanels";

/** The same display component is used for live projections and saved history. */
export function ActivityRecords({ records }: { records: ActivityRecord[] }) {
  return (
    <>
      {records.map((record) => (
        <ActivityView
          key={`${record.source.transport}:${record.source.harness}:${record.kind}:${record.id}`}
          record={record}
        />
      ))}
    </>
  );
}
export function ActivityView({ record }: { record: ActivityRecord }) {
  switch (record.kind) {
    case "plan":
      return (
        <PlanPanel
          steps={record.data.steps.map((s) => ({ ...s, text: s.title }))}
          explanation={record.data.explanation}
        />
      );
    case "file_change":
      return (
        <>
          {record.data.files.map((file, i) => (
            <FileChangePanel
              key={i}
              {...file}
              state={`${record.data.state} · ${file.operation}`}
              reason={
                file.reason ||
                (file.content !== "available" ? file.content : undefined)
              }
            />
          ))}
        </>
      );
    case "output":
      return (
        <>
          <CommandOutputPanel
            command={record.data.command}
            cwd={record.data.cwd}
            text={
              record.data.streams === "combined"
                ? outputText(record.data)
                : record.data.chunks
                    .map((c) => `[${c.stream}] ${c.text}`)
                    .join("")
            }
            stream={
              record.data.streams === "combined"
                ? "combined"
                : "Separate stdout / stderr, ordered by arrival"
            }
            exitCode={record.data.exitCode}
            signal={record.data.signal}
            state={record.data.status}
            truncated={
              record.data.truncated.droppedBytes > 0 ||
              record.data.truncated.droppedChunks > 0 ||
              !!record.data.truncated.upstream
            }
            omittedBytes={record.data.truncated.droppedBytes}
          />
          {record.data.unavailable && (
            <p className="note">{record.data.unavailable}</p>
          )}
        </>
      );
    case "tool":
      return (
        <details className="activity-panel">
          <summary>
            {record.data.title || "Tool"} · {record.data.status}
          </summary>
          {record.data.input && (
            <pre className="activity-scroll" tabIndex={0}>
              {record.data.input}
            </pre>
          )}
          {record.data.content.map((content, i) =>
            content.type === "text" ? (
              <pre key={i} className="activity-scroll">
                {content.text}
              </pre>
            ) : content.type === "unavailable" ? (
              <p key={i}>
                {content.label}: {content.reason}
              </p>
            ) : null,
          )}
          {record.data.error && <p role="alert">{record.data.error}</p>}
        </details>
      );
    case "settings":
      return (
        <details className="activity-panel">
          <summary>
            Recorded session settings · revision {record.data.revision}
          </summary>
          {record.data.options.map((option) => (
            <p key={option.id}>
              {option.label || option.id}:{" "}
              {option.confirmed === undefined
                ? "Not confirmed"
                : String(option.confirmed)}
              {option.requested !== undefined
                ? ` · Requested: ${option.requested}`
                : ""}
              {option.rejected ? ` · Rejected: ${option.rejected}` : ""} ·{" "}
              {option.application || "Timing not reported"}
            </p>
          ))}
        </details>
      );
    case "commands":
      return (
        <details className="activity-panel">
          <summary>Recorded commands · revision {record.data.revision}</summary>
          {record.data.commands.map((c) => (
            <p key={c.id}>
              {c.token} · {c.description}
              {!c.available ? ` · ${c.reason || "Unavailable"}` : ""}
            </p>
          ))}
        </details>
      );
    default:
      return assertNever(record);
  }
}
