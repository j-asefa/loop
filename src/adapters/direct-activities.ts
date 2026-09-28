import type { Emit } from "./types.js";
import { directActivityUpdate } from "../activity-bridge.js";
import {
  ActivityUpdate,
  type ActivityUpdate as Update,
} from "../agent-activities.js";
/** Structured native display extraction. These values never authorize file or command execution. */
export type DirectActivity =
  | {
      kind: "plan";
      id: string;
      steps: { id: string; text: string; status: string }[];
      explanation?: string;
    }
  | {
      kind: "file";
      id: string;
      path: string;
      oldPath?: string;
      operation?: "create" | "modify" | "delete" | "rename";
      patch?: string;
      before?: string | null;
      after?: string | null;
      state: string;
      truncated?: boolean;
    }
  | {
      kind: "output";
      id: string;
      command?: string;
      cwd?: string;
      text: string;
      stream: "combined";
      state: string;
      exitCode?: number;
      truncated?: boolean;
    };
const LIMIT = 48_000;
const str = (value: unknown): value is string => typeof value === "string";
function text(value: unknown): string {
  return Array.isArray(value)
    ? value
        .filter((part) => part?.type === "text" && str(part.text))
        .map((part) => part.text)
        .join("\n")
    : "";
}
function state(value: unknown): string {
  return value === "completed"
    ? "completed"
    : value === "failed" || value === "error"
      ? "failed"
      : value === "declined"
        ? "declined"
        : "running";
}
function plan(
  id: string,
  entries: unknown,
  explanation?: unknown,
): DirectActivity[] {
  if (!Array.isArray(entries)) return [];
  const steps = entries
    .filter(
      (entry) =>
        entry &&
        str(entry.step ?? entry.content ?? entry.text) &&
        [
          "pending",
          "inProgress",
          "in_progress",
          "completed",
          "cancelled",
        ].includes(entry.status),
    )
    .slice(0, 200)
    .map((entry, index) => ({
      // Position is scoped to a replacement revision; text is never identity.
      id: str(entry.id) ? entry.id : String(index),
      text: (entry.step ?? entry.content ?? entry.text).slice(0, 4000),
      status: entry.status === "inProgress" ? "in_progress" : entry.status,
    }));
  return [
    {
      kind: "plan",
      id,
      steps,
      ...(str(explanation) ? { explanation: explanation.slice(0, 4000) } : {}),
    },
  ];
}
function output(
  id: string,
  raw: string,
  status: unknown,
  command?: unknown,
  cwd?: unknown,
  exitCode?: unknown,
  truncated = false,
): DirectActivity {
  return {
    kind: "output",
    id,
    text: raw.slice(-LIMIT),
    stream: "combined",
    state: state(status),
    ...(str(command) ? { command: command.slice(0, 4000) } : {}),
    ...(str(cwd) ? { cwd: cwd.slice(0, 4000) } : {}),
    ...(Number.isInteger(exitCode) ? { exitCode: exitCode as number } : {}),
    truncated: truncated || raw.length > LIMIT,
  };
}

export function codexActivities(method: string, params: any): DirectActivity[] {
  if (method === "turn/plan/updated" && str(params.turnId))
    return plan("plan:" + params.turnId, params.plan, params.explanation);
  if (!["item/started", "item/completed"].includes(method)) return [];
  const item = params.item;
  if (!item || !str(item.id)) return [];
  if (item.type === "commandExecution")
    return [
      output(
        item.id,
        str(item.aggregatedOutput) ? item.aggregatedOutput : "",
        item.status,
        item.command,
        item.cwd,
        item.exitCode,
      ),
    ];
  if (item.type === "fileChange" && Array.isArray(item.changes))
    return item.changes
      .slice(0, 100)
      .flatMap((change: any, index: number): DirectActivity[] => {
        if (!str(change.path)) return [];
        const patch = str(change.diff) ? change.diff : undefined;
        const move = change.kind?.move_path ?? change.kind?.movePath;
        return [
          {
            kind: "file",
            id: `${item.id}:${index}`,
            path: str(move) ? move : change.path,
            operation: str(move)
              ? "rename"
              : change.kind?.type === "add"
                ? "create"
                : change.kind?.type === "delete"
                  ? "delete"
                  : "modify",
            ...(str(move) ? { oldPath: change.path } : {}),
            ...(patch !== undefined
              ? {
                  patch: patch.slice(0, LIMIT),
                  truncated: patch.length > LIMIT,
                }
              : {}),
            state:
              item.status === "completed"
                ? "executed"
                : item.status === "failed"
                  ? "failed"
                  : item.status === "declined"
                    ? "declined"
                    : "proposed",
          },
        ];
      });
  return [];
}

export function piActivities(
  event: any,
  input?: { toolName?: string; args?: any },
): DirectActivity[] {
  if (!str(event.toolCallId)) return [];
  const name = event.toolName ?? input?.toolName;
  const args = event.args ?? input?.args;
  const result = event.result ?? event.partialResult;
  const status =
    event.type === "tool_execution_end"
      ? event.isError
        ? "failed"
        : "completed"
      : "running";
  if (name === "bash")
    return [
      output(
        event.toolCallId,
        text(result?.content),
        status,
        args?.command,
        undefined,
        undefined,
        result?.details?.truncation?.truncated === true,
      ),
    ];
  if (
    name === "write" &&
    str(args?.path) &&
    str(args?.content) &&
    event.type === "tool_execution_end"
  )
    return [
      {
        kind: "file",
        id: event.toolCallId,
        path: args.path,
        after: args.content.slice(0, LIMIT),
        truncated: args.content.length > LIMIT,
        state: event.isError ? "failed" : "executed",
      },
    ];
  if (
    name === "edit" &&
    str(args?.path) &&
    str(result?.details?.patch ?? result?.details?.diff)
  ) {
    const patch = result.details.patch ?? result.details.diff;
    return [
      {
        kind: "file",
        id: event.toolCallId,
        path: args.path,
        patch: patch.slice(0, LIMIT),
        truncated: patch.length > LIMIT,
        state:
          status === "completed"
            ? "executed"
            : status === "failed"
              ? "failed"
              : "unknown",
      },
    ];
  }
  return [];
}

export function openCodeActivities(
  type: string,
  properties: any,
): DirectActivity[] {
  if (type === "todo.updated" && str(properties.sessionID))
    return plan("plan:" + properties.sessionID, properties.todos);
  const part = properties.part;
  if (type !== "message.part.updated" || part?.type !== "tool" || !str(part.id))
    return [];
  const s = part.state;
  if (!s) return [];
  if (part.tool === "bash")
    return [
      output(
        part.callID || part.id,
        str(s.output)
          ? s.output
          : str(s.metadata?.output)
            ? s.metadata.output
            : "",
        s.status,
        s.input?.command,
        undefined,
        s.metadata?.exit,
        s.metadata?.truncated === true,
      ),
    ];
  const diff = s.metadata?.filediff;
  if (diff && str(diff.file) && str(diff.before) && str(diff.after))
    return [
      {
        kind: "file",
        id: part.callID || part.id,
        path: diff.file,
        before: diff.before.slice(0, LIMIT),
        after: diff.after.slice(0, LIMIT),
        truncated: diff.before.length > LIMIT || diff.after.length > LIMIT,
        state:
          s.status === "completed"
            ? "executed"
            : s.status === "error"
              ? "failed"
              : "unknown",
      },
    ];
  if (diff && str(diff.file) && str(diff.patch))
    return [
      {
        kind: "file",
        id: part.callID || part.id,
        path: diff.file,
        patch: diff.patch.slice(0, LIMIT),
        truncated: diff.patch.length > LIMIT,
        state:
          s.status === "completed"
            ? "executed"
            : s.status === "error"
              ? "failed"
              : "unknown",
      },
    ];
  if (str(s.metadata?.diff) && str(s.input?.filePath))
    return [
      {
        kind: "file",
        id: part.callID || part.id,
        path: s.input.filePath,
        patch: s.metadata.diff.slice(0, LIMIT),
        truncated: s.metadata.diff.length > LIMIT,
        state:
          s.status === "completed"
            ? "executed"
            : s.status === "error"
              ? "failed"
              : "unknown",
      },
    ];
  return [];
}

export function claudeActivities(
  block: any,
  invocation?: { name: string; input: any },
): DirectActivity[] {
  if (block?.type === "tool_use" && str(block.id) && block.name === "TodoWrite")
    return plan("plan", block.input?.todos);
  if (block?.type !== "tool_result" || !str(block.tool_use_id) || !invocation)
    return [];
  if (invocation.name === "Bash") {
    // Content is the result of this correlated Bash invocation; never guess tool identity from prose.
    const raw = str(block.content) ? block.content : text(block.content);
    return [
      output(
        block.tool_use_id,
        raw,
        block.is_error ? "failed" : "completed",
        invocation.input?.command,
      ),
    ];
  }
  if (
    invocation.name === "Write" &&
    str(invocation.input?.file_path) &&
    str(invocation.input?.content)
  )
    return [
      {
        kind: "file",
        id: block.tool_use_id,
        path: invocation.input.file_path,
        after: invocation.input.content.slice(0, LIMIT),
        truncated: invocation.input.content.length > LIMIT,
        state: block.is_error ? "failed" : "executed",
      },
    ];
  // SDK exposes tool_use_result as opaque structured data; only explicitly present before/after are used.
  // Edit input describes an attempted replacement, not proof of a full-file diff.
  if (
    invocation.name === "Edit" &&
    str(invocation.input?.file_path) &&
    str(invocation.input?.old_string) &&
    str(invocation.input?.new_string)
  ) {
    return [
      {
        kind: "file",
        id: block.tool_use_id,
        path: invocation.input.file_path,
        before: invocation.input.old_string.slice(0, LIMIT),
        after: invocation.input.new_string.slice(0, LIMIT),
        state: block.is_error ? "failed" : "executed",
        truncated:
          invocation.input.old_string.length > LIMIT ||
          invocation.input.new_string.length > LIMIT,
      },
    ];
  }
  return [];
}

/**
 * Convert extractor values at the adapter boundary; only ActivityUpdate
 * crosses the wire. Live adapters and native history share one mapping
 * (`directActivityUpdate`) so refresh, fork and live runs render alike.
 */
export function directUpdates(
  harness: string,
  values: DirectActivity[],
  context: { transport?: "native" | "api"; origin?: string } = {},
): Update[] {
  return values.flatMap((value): Update[] => {
    const parsed = ActivityUpdate.safeParse(
      directActivityUpdate(value, {
        harness,
        origin: context.origin || `${harness}:structured`,
        transport: context.transport,
      }),
    );
    return parsed.success ? [parsed.data] : [];
  });
}

/** Instance-local sequence: never share counters between adapter processes. */
export function directActivityEmitter(emit: Emit): Emit {
  let sequence = 0;
  const offsets = new Map<string, number>();
  return (event) => {
    if (event.type !== "activity") return emit(event);
    const activity = { ...event.activity, seq: ++sequence };
    if (activity.kind === "output") {
      const key = activity.id;
      if (activity.patch.replace)
        offsets.set(key, activity.patch.replace.length);
      if (activity.patch.append) {
        let offset = offsets.get(key) || 0;
        activity.patch = {
          ...activity.patch,
          append: activity.patch.append.map((chunk) => ({
            ...chunk,
            index: offset++,
          })),
        };
        offsets.set(key, offset);
      }
    }
    emit({ ...event, activity });
  };
}
