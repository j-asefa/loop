import type { CheckoutSummary } from "../shared/checkout.js";
import type { VerificationSummary } from "../shared/verification.js";
import type { PullState } from "../shared/pull-state.js";

export type FeedRow = {
  conversation_id: string;
  title: string;
  card_title?: string;
  agent_id: string | null;
  execution_connection_id: string | null;
  team_id: string | null;
  origin: string;
  folder_id: string | null;
  run_id: string | null;
  done_run_id: string | null;
  done_card_key: string;
  last_activity_at: number;
  sort_at: number;
  position_message_id: string | null;
  later_id: string | null;
  pending_approvals: number;
  agent_name: string | null;
  provider: string | null;
  project_id: string | null;
  project_name: string | null;
  card_run: string | null;
  card_run_state: string | null;
  card_run_error: string | null;
  card_run_input: string | null;
  card_run_connection_id: string | null;
  card_run_model: string | null;
  card_run_resolved_model: string | null;
  card_run_created_at: number | null;
  card_run_updated_at: number | null;
  message_id: string | null;
  message_role: string | null;
  message_content: string | null;
  message_metadata: string | null;
  message_created_at: number | null;
  message_automation: string | null;
  message_automation_from: string | null;
  message_saved: number;
  trigger_automation: string | null;
  trigger_automation_from: string | null;
  card_answer_id: string | null;
  approval_id: string | null;
  approval_run_id: string | null;
  approval_message_id: string | null;
  decision_id: string | null;
  decision_run_id: string | null;
  decision_request: string | null;
  later_due_at: number | null;
  later_condition: string | null;
  later_surfaced_at: number | null;
  queued: number;
};

export type FeedCardDetail = {
  checkout: CheckoutSummary | null;
  verification: VerificationSummary | null;
  queue_position: number | null;
  moves: { can_move_up: boolean; can_move_down: boolean };
  pull: PullState | null;
  queued_runs: {
    id: string;
    input: string;
    created_at: number;
    queue_position: number;
    can_edit: boolean;
    can_move_up: boolean;
    can_move_down: boolean;
  }[];
  live_preview: string | null;
};
const collapse = (text: string | null | undefined, max: number) =>
  (text || "").replace(/\s+/g, " ").trim().slice(0, max);
export function feedCardTitle(row: FeedRow) {
  return (
    row.card_title ??
    ((row.card_run_state && collapse(row.card_run_input, 200)) || row.title)
  );
}
export function feedMessagePrefix(text: string) {
  // Match SQLite substr: its limit counts Unicode code points, not UTF-16.
  let value = "",
    count = 0;
  for (const point of text) {
    if (count++ === 1000) break;
    value += point;
  }
  return value;
}
export function displayFeedCard(
  detail: FeedCardDetail,
  row: FeedRow,
  mode: "thread" | "done" | "working" = "thread",
) {
  const run = row.card_run_state
    ? {
        id: row.card_run!,
        state: row.card_run_state,
        error: row.card_run_error,
        input: row.card_run_input!,
        connection_id: row.card_run_connection_id,
        model: row.card_run_model,
        resolved_model: row.card_run_resolved_model,
        created_at: row.card_run_created_at!,
        updated_at: row.card_run_updated_at!,
      }
    : undefined;
  const message = row.message_id
    ? {
        id: row.message_id,
        role: row.message_role!,
        content: row.message_content!,
        created_at: row.message_created_at!,
        automation: row.message_automation,
        automation_from: row.message_automation_from,
      }
    : undefined;
  // The prompt is hidden while its run works, so keep who started it: a
  // watched pull request or a teammate agent rather than you.
  const trigger =
    run && message?.role !== "user"
      ? {
          automation: row.trigger_automation,
          automation_from: row.trigger_automation_from,
        }
      : undefined;
  return {
    conversation_id: row.conversation_id,
    ...(mode === "done" ? { done_card_key: row.done_card_key } : {}),
    // The thread keeps the title from its first prompt, but a card is named
    // by the prompt of the run it shows: a Done card by the prompt its answer
    // replies to, a Working card by the task in progress. Imported history
    // has no runs and keeps the thread title.
    title: feedCardTitle(row),
    agent_id: row.agent_id,
    connection_id: row.execution_connection_id,
    agent_name: row.agent_name ?? null,
    provider: row.provider ?? null,
    project_id: row.folder_id ? (row.project_id ?? null) : null,
    project_name: row.folder_id ? (row.project_name ?? null) : null,
    team_id: row.team_id,
    origin: row.origin,
    last_activity_at: mode === "done" ? row.sort_at : row.last_activity_at,
    last_message: message
      ? {
          id: message.id,
          role: message.role,
          preview: collapse(message.content, 200),
          // Markdown for full-size Feed cards; the card clips it visually.
          content: message.content.slice(0, 4000),
          created_at: message.created_at,
          // So the card's menu offers Save or Remove from Saved, as the
          // thread and the result card already do.
          saved: !!row.message_saved,
          // Sent by Loop for you (a watched pull request or a teammate
          // agent), not typed by you.
          ...(message.automation ? { automation: message.automation } : {}),
          ...(message.automation_from
            ? { automation_from: message.automation_from }
            : {}),
        }
      : null,
    run: run
      ? {
          ...run,
          input: run.input.slice(0, 1000),
          // What Loop observed in the agent's worktree. Absent for API agents
          // and for runs that have not started, so those cards are unchanged.
          ...(detail.checkout ? { checkout: detail.checkout } : {}),
          ...(detail.verification ? { verification: detail.verification } : {}),
          ...(trigger?.automation
            ? {
                automation: trigger.automation,
                automation_from: trigger.automation_from,
              }
            : {}),
          queue_position: run.state === "queued" ? detail.queue_position : null,
          ...(run.state === "queued"
            ? detail.moves
            : { can_move_up: false, can_move_down: false }),
        }
      : null,
    // Queued follow-ups, listed separately so they stay manageable while
    // the thread's current run is still working.
    // The thread's pull request as its watch last saw it. Null says there
    // is none; a response without the key comes from a server that does not
    // report it, and the client treats that as unknown.
    pull: detail.pull,
    queued_runs: mode === "done" ? [] : detail.queued_runs,
    // While the agent works, its card shows what it has written so far.
    live_preview:
      run &&
      [
        "running",
        "pausing",
        "waiting_children",
        "paused",
        "awaiting_approval",
      ].includes(run.state)
        ? detail.live_preview
        : null,
    pending_approvals: mode === "done" ? 0 : row.pending_approvals,
    position_message_id: row.position_message_id,
    later: row.later_id
      ? {
          id: row.later_id,
          due_at: row.later_due_at,
          condition: row.later_condition,
          surfaced_at: row.later_surfaced_at,
        }
      : null,
    next_action: nextAction(row, run, mode === "done"),
  };
}

export type NextAction = {
  kind: "approve" | "answer" | "result";
  message_id: string | null;
  run_id: string;
  ref?: string;
};
function nextAction(
  row: FeedRow,
  run: { id: string; state: string } | undefined,
  // A Done card opens at its answer, whatever the thread waits on now.
  resultOnly: boolean,
): NextAction | null {
  if (!resultOnly && row.approval_run_id)
    return {
      kind: "approve",
      run_id: row.approval_run_id,
      message_id: row.approval_message_id,
    };
  if (!resultOnly && row.decision_run_id) {
    let questions = false;
    try {
      const request = JSON.parse(row.decision_request || "");
      questions =
        Array.isArray(request?.questions) && request.questions.length > 0;
    } catch {}
    // Native decisions are answered at the end of the thread.
    return {
      kind: questions ? "answer" : "approve",
      run_id: row.decision_run_id,
      message_id: null,
    };
  }
  if (run?.state === "completed" && row.card_answer_id)
    return { kind: "result", run_id: run.id, message_id: row.card_answer_id };
  return null;
}
