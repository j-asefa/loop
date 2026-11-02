import * as personalDecisionsQueries from "./sql/personal-decisions.js";
import { z } from "zod";
import { db, now } from "./db.js";
import { Problem } from "./domain.js";
import type { Request } from "../protocol.js";
import {
  PersonalDecisionsPageSchema,
  PersonalDecisionsQuery,
  PersonalApprovalSchema,
  PERSONAL_DECISION_DETAIL_LIMIT,
  PERSONAL_DECISION_RESPONSE_LIMIT,
  type PersonalDecision,
  type PersonalDecisionsPage,
  type PersonalApproval,
} from "../shared/personal-decisions.js";

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export function personalApproval(owner: string, id: string): PersonalApproval {
  const row = personalDecisionsQueries.approval(db, id, owner) as
    { source: "approval" | "native"; request: string } | undefined;
  if (!row) throw new Problem(404, "Approval history not found");
  return PersonalApprovalSchema.parse({
    source: row.source,
    request: JSON.parse(row.request),
  });
}

// Budgets count serialized UTF-8 bytes, including JSON escaping. Truncating by
// characters alone does not bound a page of Unicode or control-character text.
function previewText(value: string, budget: number): string {
  if (jsonBytes(value) <= budget) return value;
  let low = 0;
  let high = Math.min(value.length, budget);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (jsonBytes(value.slice(0, mid) + "…") <= budget) low = mid;
    else high = mid - 1;
  }
  // Do not leave an unmatched surrogate at the cut.
  if (low && /[\uD800-\uDBFF]/.test(value[low - 1])) low--;
  return value.slice(0, low) + "…";
}

function previewValues(values: string[], budget: number) {
  const result: string[] = [];
  let size = 2; // Array brackets.
  let truncated = false;
  for (const value of values.slice(0, 30)) {
    const available = budget - size - (result.length ? 1 : 0);
    if (available < 5) break; // A quoted ellipsis must fit.
    const text = previewText(value, available);
    size += jsonBytes(text) + (result.length ? 1 : 0);
    result.push(text);
    truncated ||= text !== value;
  }
  return {
    values: result,
    truncated: truncated || result.length < values.length,
  };
}

type Questions = NonNullable<Request["questions"]>;

function responsePreview(
  questions: Questions,
  answer: Record<string, unknown>,
) {
  const secretIds = new Set(questions.filter((q) => q.secret).map((q) => q.id));
  const response: Record<string, string[] | null> = Object.create(null);
  let size = 2; // Object braces.
  let truncated = questions.length > 50;
  for (const q of questions.slice(0, 50)) {
    if (Object.hasOwn(response, q.id)) continue;
    const keySize = jsonBytes(q.id) + 1 + (size > 2 ? 1 : 0);
    const available = PERSONAL_DECISION_RESPONSE_LIMIT - size - keySize;
    if (available < 4) {
      truncated = true;
      break;
    }
    const preview = secretIds.has(q.id)
      ? { values: null, truncated: false }
      : previewValues(answer[q.id] as string[], available);
    // An omitted nonempty answer must not look like an intentionally empty one.
    const values =
      preview.truncated && !preview.values?.length ? null : preview.values;
    response[q.id] = values;
    size += keySize + jsonBytes(values);
    truncated ||= preview.truncated;
  }
  return { response, truncated };
}

function answerPreview(
  questions: Questions,
  response: Record<string, unknown> | null,
) {
  const answers: PersonalDecision["answers"] = [];
  const secretIds = new Set(questions.filter((q) => q.secret).map((q) => q.id));
  let size = 2;
  let truncated = questions.length > 50;
  for (const q of questions.slice(0, 50)) {
    const question = previewText(q.title, 512);
    const secret = secretIds.has(q.id);
    const entry: PersonalDecision["answers"][number] = {
      question,
      secret,
      values: null,
    };
    const baseSize = jsonBytes(entry) + (answers.length ? 1 : 0);
    if (size + baseSize > PERSONAL_DECISION_RESPONSE_LIMIT) {
      truncated = true;
      break;
    }
    const values = !secret ? response?.[q.id] : null;
    if (Array.isArray(values) && values.every((v) => typeof v === "string")) {
      const preview = previewValues(
        values,
        PERSONAL_DECISION_RESPONSE_LIMIT - size - baseSize + 4,
      );
      entry.values =
        preview.truncated && !preview.values.length ? null : preview.values;
      truncated ||= preview.truncated;
    }
    size += jsonBytes(entry) + (answers.length ? 1 : 0);
    answers.push(entry);
    truncated ||= question !== q.title;
  }
  return { answers, truncated };
}

/** Called in the transaction claiming a validated, explicit user response. */
export function recordPersonalDecision(input: {
  owner: string;
  run: string;
  approval?: string;
  native?: string;
  request?: Request;
  answer: Record<string, unknown>;
}) {
  const request = input.request;
  // Keep only fields declared by the request. Secret fields and unsolicited
  // answer keys never enter durable history or its browser projection.
  const preview =
    request?.kind === "question"
      ? responsePreview(request.questions || [], input.answer)
      : {
          response: { choice: previewText(input.answer.choice as string, 256) },
          truncated: jsonBytes(input.answer.choice) > 256,
        };
  personalDecisionsQueries.insert(
    db,
    input.approval ? "approval:" + input.approval : "native:" + input.native,
    input.owner,
    input.run,
    input.approval || null,
    input.native || null,
    request?.kind === "question" ? "answer" : "approval",
    JSON.stringify(preview.response),
    Number(preview.truncated),
    now(),
  );
}

type Row = {
  id: string;
  kind: "approval" | "answer";
  request: string;
  response: string | null;
  response_truncated: number;
  state: string;
  native_decision_id: string | null;
  created_at: number;
  conversation_id: string | null;
  conversation_title: string | null;
  agent_name: string | null;
};
export function personalDecisions(
  owner: string,
  input: unknown,
): PersonalDecisionsPage {
  const query = PersonalDecisionsQuery.parse(input);
  let cursor: [number, string] = [Number.MAX_SAFE_INTEGER, ""];
  if (query.before) {
    try {
      cursor = z
        .tuple([
          z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          z.string().min(1).max(200),
        ])
        .parse(
          JSON.parse(Buffer.from(query.before, "base64url").toString("utf8")),
        );
    } catch {
      throw new Problem(400, "Invalid decision history cursor");
    }
  }
  const rows = personalDecisionsQueries.page(
    db,
    owner,
    query.kind,
    ...cursor,
  ) as Row[];
  const more = rows.length > 50;
  if (more) rows.pop();
  const last = rows.at(-1);
  return PersonalDecisionsPageSchema.parse({
    items: rows.map((row) => {
      const request = JSON.parse(row.request);
      // Older records may contain complete answers. Bound them in SQL before
      // materializing the page, and never parse a truncated JSON fragment.
      const oversizedResponse =
        !!row.response &&
        Buffer.byteLength(row.response) > PERSONAL_DECISION_RESPONSE_LIMIT;
      const response =
        row.response && !oversizedResponse ? JSON.parse(row.response) : null;
      const oversizedQuestions =
        !!request.questionsText &&
        Buffer.byteLength(request.questionsText) > 65536;
      const questions: Questions =
        request.questionsText && !oversizedQuestions
          ? JSON.parse(request.questionsText)
          : [];
      const preview = answerPreview(questions, response);
      const native = !!row.native_decision_id;
      // Bound the SQL projection before materializing rows in JavaScript:
      // tool arguments can be several megabytes each.
      let argumentsText = request.argumentsText;
      if (
        typeof argumentsText === "string" &&
        argumentsText.length <= PERSONAL_DECISION_DETAIL_LIMIT
      ) {
        try {
          argumentsText = JSON.stringify(JSON.parse(argumentsText), null, 2);
        } catch {
          /* Truncated or scalar text remains a preview. */
        }
      }
      const detail = native
        ? (request.detail ?? "")
        : [request.message, argumentsText]
            .filter((value) => typeof value === "string")
            .join("\n\n");
      const detailPreview = previewText(detail, PERSONAL_DECISION_DETAIL_LIMIT);
      const choice =
        row.kind === "approval" && typeof response?.choice === "string"
          ? previewText(response.choice, 256)
          : null;
      return {
        id: row.id,
        cursor: Buffer.from(JSON.stringify([row.created_at, row.id])).toString(
          "base64url",
        ),
        kind: row.kind,
        state: row.state,
        created_at: row.created_at,
        conversation_id: row.conversation_id,
        conversation_title:
          row.conversation_title === null
            ? null
            : previewText(row.conversation_title, 1024),
        agent_name:
          row.agent_name === null ? null : previewText(row.agent_name, 256),
        title: previewText(
          native
            ? (request.title ?? "Request unavailable")
            : request.tool
              ? request.tool
                  .replaceAll("_", " ")
                  .replace(/^./, (c: string) => c.toUpperCase())
              : request.type === "mcp_install"
                ? "Install workspace tools"
                : "Review requested action",
          1024,
        ),
        // Installation configuration can contain credentials. Only the public
        // request description belongs here, never config or execution results.
        detail: detailPreview,
        detail_truncated: detailPreview !== detail,
        choice,
        answers: row.kind === "answer" ? preview.answers : [],
        response_recorded: row.response !== null,
        response_truncated:
          !!row.response_truncated ||
          oversizedResponse ||
          oversizedQuestions ||
          preview.truncated ||
          (choice !== null && choice !== response?.choice),
      };
    }),
    next:
      more && last
        ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString(
            "base64url",
          )
        : null,
  });
}
