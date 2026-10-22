import { cardAttachments } from "./card-attachments.js";
import type { CardEntry } from "../shared/cards.js";
import { DoneDisplaySchema } from "../shared/done-card.js";
import { doneCardRows } from "./mobile-return.js";

export function doneCards(
  owner: string,
  options: Parameters<typeof doneCardRows>[1],
): CardEntry[] {
  return doneCardRows(owner, options).map(({ row, display }) => ({
    card: {
      type: "done",
      id: "d:" + (row.done_card_key ?? "idle:" + row.conversation_id),
      source: {
        artifact_id: null,
        message_id: row.message_id,
        conversation_id: row.conversation_id,
        run_id: row.card_run,
        agent_id: row.agent_id,
      },
      author: {
        kind: row.card_run && row.message_id && row.agent_id ? "agent" : "unknown",
        id: row.card_run ? row.agent_id : null,
        name: row.card_run ? row.agent_name : null,
        provider: row.card_run ? row.provider : null,
      },
      recipient: null,
      context: {
        conversation_title: row.title,
        folder_id: row.folder_id,
        project_id: row.project_id,
        project_name: row.project_name,
        team_id: row.team_id,
      },
      content: row.message_content ?? "",
      format: "markdown",
      created_at:
        row.message_created_at ?? row.card_run_created_at ?? row.sort_at,
      updated_at: null,
      saved: !!row.message_saved,
      attachments: cardAttachments(
        owner,
        JSON.parse(row.message_metadata ?? "{}"),
      ),
      href:
        "/?conversation=" +
        encodeURIComponent(row.conversation_id) +
        (row.message_id
          ? "&message=" + encodeURIComponent(row.message_id)
          : ""),
      display: DoneDisplaySchema.parse({ ...display, position_message_id: null }),
    },
    order: [
      row.sort_at,
      row.conversation_id + "\u001f" + (row.done_card_key ?? ""),
    ],
    saved: null,
  }));
}
