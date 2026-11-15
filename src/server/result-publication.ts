import type Database from "better-sqlite3";
import { db } from "./db.js";
import { Problem } from "../shared/problem.js";
import {
  collapseResultTitle,
  messageResultId,
  PublishResultInputSchema,
  replyResultId,
  RequestedResultContextSchema,
  RESULT_SCHEMA_VERSION,
  ResultIdSchema,
  runResultId,
  type CanonicalResult,
  type PublishResultInput,
  type RequestedResultContext,
  type ResultAttachmentRef,
  type ResultId,
  type ResultStimulus,
  type ResultSupplyItem,
} from "../shared/result.js";
import { computeResultContentDigest } from "./result-digest.js";
import { parseCanonicalResult, type Message } from "./row-schemas.js";
import * as resultsQueries from "./sql/results.js";
import * as resultContextEdgesQueries from "./sql/result-context-edges.js";

export const MAX_RESULT_SUPPLY_ITEMS = 6;
export const MAX_RESULT_SUPPLY_CHARS = 2_400;
export const MAX_TOTAL_RESULT_SUPPLY_CHARS = 7_200;

function isEligibleAnswerMessage(message: Message): boolean {
  if (message.role !== "assistant") return false;
  if (message.content.trim().length === 0) return false;
  const meta = message.metadata;
  if (meta.progress === true || meta.partial === true) {
    return false;
  }
  return true;
}

function readResolvedModelFromRunResult(
  runResultJson: string | null | undefined,
): string | null {
  if (!runResultJson) return null;
  try {
    const parsed: unknown = JSON.parse(runResultJson);
    if (
      parsed &&
      typeof parsed === "object" &&
      "resolvedModel" in parsed &&
      typeof (parsed as { resolvedModel?: unknown }).resolvedModel === "string"
    ) {
      const val = (parsed as { resolvedModel: string }).resolvedModel.trim();
      return val.length > 0 ? val : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function snapshotMessageAttachments(
  ownerId: string,
  message: Message,
  database: Database.Database = db,
): ResultAttachmentRef[] {
  const rawAttachments = message.metadata.attachments;
  if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) {
    return [];
  }
  const refs: ResultAttachmentRef[] = [];
  for (const item of rawAttachments) {
    const artifact = resultsQueries.artifactById(database, ownerId, item.id);
    if (!artifact) continue;
    const artMeta = artifact.metadata as {
      objectId?: string;
      mime?: string;
      size?: number;
    };
    const candidateObjectId =
      (typeof item.objectId === "string" && item.objectId.length > 0
        ? item.objectId
        : null) ??
      (typeof artMeta.objectId === "string" && artMeta.objectId.length > 0
        ? artMeta.objectId
        : null);
    const objectId = candidateObjectId
      ? (resultsQueries.ownedObjectId(database, ownerId, candidateObjectId)
          ?.id ?? null)
      : null;
    const publishedObj = resultsQueries.publishedArtifactObject(
      database,
      ownerId,
      artifact.id,
    );
    const name =
      (typeof item.name === "string" && item.name.trim()) ||
      artifact.title.trim() ||
      artifact.id;
    const mime =
      (typeof item.mime === "string" && item.mime.trim()) ||
      (typeof artMeta.mime === "string" && artMeta.mime.trim()) ||
      publishedObj?.mime ||
      "application/octet-stream";
    const rawSize = item.size ?? artMeta.size ?? publishedObj?.size ?? 0;
    const size =
      typeof rawSize === "number" && Number.isFinite(rawSize) && rawSize >= 0
        ? Math.trunc(rawSize)
        : 0;
    refs.push({
      artifactId: artifact.id,
      objectId,
      version: Math.max(1, Math.trunc(artifact.version || 1)),
      sha256: publishedObj?.checksum ?? null,
      name,
      mime,
      size,
      published: Boolean(publishedObj),
    });
  }
  return refs;
}

export function publishResult(
  input: PublishResultInput,
  database: Database.Database = db,
): CanonicalResult {
  const parsed = PublishResultInputSchema.parse(input);
  const contentDigest = computeResultContentDigest(parsed);

  return database
    .transaction((): CanonicalResult => {
      const existing = resultsQueries.byId(database, parsed.ownerId, parsed.id);
      if (existing) {
        if (existing.sealed === 1) {
          if (existing.content_digest === contentDigest) {
            return parseCanonicalResult(existing);
          }
          throw new Problem(
            409,
            "Result publication identity was reused with different content",
          );
        }
      }

      const row: resultsQueries.InsertResultRow = {
        id: parsed.id,
        owner_id: parsed.ownerId,
        schema_version: RESULT_SCHEMA_VERSION,
        kind: parsed.kind,
        origin_completeness: "sealed_at_publication",
        sealed: 1,
        created_at: parsed.createdAt,
        conversation_id: parsed.provenance.conversationId,
        run_id: parsed.provenance.runId,
        message_id: parsed.provenance.messageId,
        agent_id: parsed.provenance.agentId,
        content_digest: contentDigest,
        stimulus: JSON.stringify(parsed.stimulus),
        outcome: JSON.stringify(parsed.outcome),
        attachments: JSON.stringify(parsed.attachments),
        provenance: JSON.stringify(parsed.provenance),
        lineage: JSON.stringify(parsed.lineage),
      };

      if (existing) {
        resultsQueries.sealDraft(database, row);
      } else {
        resultsQueries.insert(database, row);
      }

      resultContextEdgesQueries.deleteByResult(
        database,
        parsed.ownerId,
        parsed.id,
      );
      for (const [
        position,
        supplied,
      ] of parsed.lineage.suppliedContext.entries()) {
        resultContextEdgesQueries.insert(
          database,
          parsed.ownerId,
          parsed.id,
          supplied.resultId,
          position,
          supplied.excerpt ? 1 : 0,
          parsed.createdAt,
        );
      }

      if (parsed.kind === "run_answer" || parsed.kind === "imported_answer") {
        resultsQueries.markFeedCardDirty(
          database,
          parsed.ownerId,
          parsed.provenance.conversationId,
          parsed.id,
        );
      }

      const stored = resultsQueries.byId(database, parsed.ownerId, parsed.id);
      if (!stored) {
        throw new Problem(500, "Failed to persist canonical result");
      }
      return parseCanonicalResult(stored);
    })
    .immediate();
}

export function resolveSuppliedResultSnapshots(
  ownerId: string,
  requested: RequestedResultContext[],
  database: Database.Database = db,
): ResultSupplyItem[] {
  if (requested.length === 0) return [];
  if (requested.length > MAX_RESULT_SUPPLY_ITEMS) {
    throw new Problem(
      400,
      `At most ${MAX_RESULT_SUPPLY_ITEMS} context results may be attached`,
    );
  }
  const items: ResultSupplyItem[] = [];
  let totalChars = 0;

  for (const rawReq of requested) {
    const req = RequestedResultContextSchema.parse(rawReq);
    const result = resultsQueries.canonicalById(
      database,
      ownerId,
      req.resultId,
    );
    if (!result) {
      throw new Problem(404, `Referenced result not found: ${req.resultId}`);
    }
    const normalizedBody = result.outcome.body.replace(/\r\n/g, "\n");
    let suppliedText: string;
    let isExcerpt = false;
    let isTruncated = false;

    if (req.excerpt !== undefined) {
      const normalizedExcerpt = req.excerpt.replace(/\r\n/g, "\n").trim();
      if (
        normalizedExcerpt.length === 0 ||
        !normalizedBody.includes(normalizedExcerpt)
      ) {
        throw new Problem(
          400,
          "Requested result excerpt does not match published result body",
        );
      }
      isExcerpt = true;
      if (normalizedExcerpt.length > MAX_RESULT_SUPPLY_CHARS) {
        suppliedText = normalizedExcerpt.slice(0, MAX_RESULT_SUPPLY_CHARS);
        isTruncated = true;
      } else {
        suppliedText = normalizedExcerpt;
        isTruncated = normalizedExcerpt.length < normalizedBody.length;
      }
    } else if (normalizedBody.length > MAX_RESULT_SUPPLY_CHARS) {
      suppliedText = normalizedBody.slice(0, MAX_RESULT_SUPPLY_CHARS);
      isTruncated = true;
    } else {
      suppliedText = normalizedBody;
    }

    const remaining = MAX_TOTAL_RESULT_SUPPLY_CHARS - totalChars;
    if (remaining <= 0) {
      throw new Problem(
        400,
        `Attached result context exceeds maximum budget of ${MAX_TOTAL_RESULT_SUPPLY_CHARS} characters`,
      );
    }
    if (suppliedText.length > remaining) {
      suppliedText = suppliedText.slice(0, remaining);
      isTruncated = true;
    }
    totalChars += suppliedText.length;

    items.push({
      resultId: result.id,
      contentDigest: result.contentDigest,
      title: result.outcome.title,
      agentId: result.provenance.agentId,
      agentName: result.provenance.agentName,
      conversationId: result.provenance.conversationId,
      suppliedText,
      excerpt: isExcerpt,
      truncated: isTruncated,
    });
  }

  return items;
}

export function publishCompletedRunResult(
  runId: string,
  ownerId: string,
  database: Database.Database = db,
): CanonicalResult | null {
  const id = runResultId(runId);
  const existing = resultsQueries.byId(database, ownerId, id);
  if (existing && existing.sealed === 1) {
    return parseCanonicalResult(existing);
  }

  const run = resultsQueries.runRow(database, ownerId, runId);
  if (!run || run.state !== "completed" || !run.conversation_id) {
    return null;
  }
  const conversation = resultsQueries.conversationSummary(
    database,
    ownerId,
    run.conversation_id,
  );
  if (!conversation) return null;

  const candidates = resultsQueries.runAssistantMessages(
    database,
    ownerId,
    run.conversation_id,
    run.id,
  );
  const answer = candidates.find(isEligibleAnswerMessage);
  if (!answer) return null;

  const triggerMessage = resultsQueries.runTriggerMessage(
    database,
    ownerId,
    run.conversation_id,
    run.id,
  );
  const triggerMessageId = triggerMessage?.id ?? null;
  const automationKind = triggerMessage?.metadata.automation?.kind ?? null;
  const automationFrom = triggerMessage?.metadata.automation?.fromName ?? null;

  let stimulusKind: ResultStimulus["kind"] = "user_prompt";
  let authorKind: ResultStimulus["authorKind"] = "owner";
  if (automationKind === "agent_message" || automationKind === "agent_result") {
    stimulusKind = "delegation";
    authorKind = "agent";
  } else if (automationKind === "feed_digest") {
    stimulusKind = "schedule";
    authorKind = "system";
  } else if (automationKind) {
    stimulusKind = "system";
    authorKind = "system";
  }

  const agentId = run.agent_id ?? conversation.agent_id ?? null;
  const agent = agentId
    ? resultsQueries.agentSummary(database, ownerId, agentId)
    : undefined;
  const agentName = agent?.name.trim() || agentId || "Agent";
  const model =
    (typeof run.payload.model === "string" && run.payload.model.trim()) ||
    agent?.model ||
    null;
  const resolvedModel = readResolvedModelFromRunResult(run.result);
  const connectionId =
    (typeof run.payload.connectionId === "string" &&
      run.payload.connectionId.trim()) ||
    conversation.execution_connection_id ||
    agent?.connection_id ||
    null;

  const parentRow = resultsQueries.latestCompletedBeforeRun(
    database,
    ownerId,
    run.conversation_id,
    run.id,
  );
  const parentResultId: ResultId | null = parentRow
    ? ResultIdSchema.parse(parentRow.id)
    : null;

  return publishResult(
    {
      id,
      ownerId,
      kind: "run_answer",
      createdAt: Math.max(
        0,
        Math.trunc(run.updated_at || answer.created_at || run.created_at),
      ),
      stimulus: {
        kind: stimulusKind,
        text: run.input,
        sourceMessageId: triggerMessageId,
        authorKind,
        automationKind,
        automationFrom,
      },
      outcome: {
        title: collapseResultTitle(
          run.input || answer.content,
          conversation.title || "Result",
          200,
        ),
        body: answer.content,
        format: "markdown",
      },
      attachments: snapshotMessageAttachments(ownerId, answer, database),
      provenance: {
        agentId,
        agentName,
        provider: agent?.provider ?? null,
        model,
        resolvedModel,
        connectionId,
        conversationId: run.conversation_id,
        runId: run.id,
        messageId: answer.id,
      },
      lineage: {
        parentResultId,
        triggerMessageId,
        suppliedContext: [],
      },
    },
    database,
  );
}

export function publishSteeringReplyResult(
  options: {
    ownerId: string;
    messageId: string;
    steeringId: string;
    createdAt?: number;
  },
  database: Database.Database = db,
): CanonicalResult | null {
  const id = replyResultId(options.messageId);
  const existing = resultsQueries.byId(database, options.ownerId, id);
  if (existing && existing.sealed === 1) {
    return parseCanonicalResult(existing);
  }

  const message = resultsQueries.messageById(
    database,
    options.ownerId,
    options.messageId,
  );
  if (!message || message.role !== "assistant") return null;

  const conversation = resultsQueries.conversationSummary(
    database,
    options.ownerId,
    message.conversation_id,
  );
  if (!conversation) return null;

  const steering = resultsQueries.steeringQuestion(
    database,
    options.ownerId,
    options.steeringId,
  );
  const runId = steering?.run_id ?? message.run_id ?? null;
  const run = runId
    ? resultsQueries.runRow(database, options.ownerId, runId)
    : undefined;
  const agentId = run?.agent_id ?? conversation.agent_id ?? null;
  const agent = agentId
    ? resultsQueries.agentSummary(database, options.ownerId, agentId)
    : undefined;
  const agentName = agent?.name.trim() || agentId || "Agent";
  const model =
    (typeof run?.payload.model === "string" && run.payload.model.trim()) ||
    agent?.model ||
    null;
  const resolvedModel = readResolvedModelFromRunResult(run?.result);
  const connectionId =
    (typeof run?.payload.connectionId === "string" &&
      run.payload.connectionId.trim()) ||
    conversation.execution_connection_id ||
    agent?.connection_id ||
    null;
  const questionText = steering?.question_content ?? null;
  const questionId = steering?.question_id ?? null;

  return publishResult(
    {
      id,
      ownerId: options.ownerId,
      kind: "steering_reply",
      createdAt: Math.max(
        0,
        Math.trunc(options.createdAt ?? message.created_at),
      ),
      stimulus: {
        kind: "steering_question",
        text: questionText,
        sourceMessageId: questionId,
        authorKind: "owner",
        automationKind: null,
        automationFrom: null,
      },
      outcome: {
        title: collapseResultTitle(
          questionText || message.content,
          conversation.title || "Reply",
          200,
        ),
        body: message.content,
        format: "markdown",
      },
      attachments: snapshotMessageAttachments(
        options.ownerId,
        message,
        database,
      ),
      provenance: {
        agentId,
        agentName,
        provider: agent?.provider ?? null,
        model,
        resolvedModel,
        connectionId,
        conversationId: message.conversation_id,
        runId,
        messageId: message.id,
      },
      lineage: {
        parentResultId: null,
        triggerMessageId: questionId,
        suppliedContext: [],
      },
    },
    database,
  );
}

export function publishImportedConversationResults(
  ownerId: string,
  conversationId: string,
  database: Database.Database = db,
): CanonicalResult[] {
  const conversation = resultsQueries.conversationSummary(
    database,
    ownerId,
    conversationId,
  );
  if (!conversation) return [];
  const agentId = conversation.agent_id ?? null;
  const agent = agentId
    ? resultsQueries.agentSummary(database, ownerId, agentId)
    : undefined;
  const agentName = agent?.name.trim() || agentId || "Agent";

  const messages = resultsQueries.standaloneAssistantMessages(
    database,
    ownerId,
    conversationId,
  );
  const published: CanonicalResult[] = [];
  let previousResultId: ResultId | null = null;

  for (const message of messages) {
    if (!isEligibleAnswerMessage(message)) continue;
    const id = messageResultId(message.id);
    const precedingUser = resultsQueries.precedingStandaloneUserMessage(
      database,
      ownerId,
      conversationId,
      message.id,
    );
    const promptText = precedingUser?.content ?? null;
    const promptId = precedingUser?.id ?? null;

    const result = publishResult(
      {
        id,
        ownerId,
        kind: "imported_answer",
        createdAt: Math.max(0, Math.trunc(message.created_at)),
        stimulus: {
          kind: conversation.origin.endsWith("import")
            ? "import"
            : "user_prompt",
          text: promptText,
          sourceMessageId: promptId,
          authorKind: "owner",
          automationKind: null,
          automationFrom: null,
        },
        outcome: {
          title: collapseResultTitle(
            promptText || message.content,
            conversation.title || "Result",
            200,
          ),
          body: message.content,
          format: "markdown",
        },
        attachments: snapshotMessageAttachments(ownerId, message, database),
        provenance: {
          agentId,
          agentName,
          provider: agent?.provider ?? null,
          model: agent?.model ?? null,
          resolvedModel: null,
          connectionId:
            conversation.execution_connection_id ??
            agent?.connection_id ??
            null,
          conversationId,
          runId: null,
          messageId: message.id,
        },
        lineage: {
          parentResultId: previousResultId,
          triggerMessageId: promptId,
          suppliedContext: [],
        },
      },
      database,
    );
    published.push(result);
    previousResultId = result.id;
  }

  return published;
}

export function getResult(
  ownerId: string,
  resultId: string,
  database: Database.Database = db,
): CanonicalResult | undefined {
  const parsedId = ResultIdSchema.safeParse(resultId);
  if (!parsedId.success) return undefined;
  return resultsQueries.canonicalById(database, ownerId, parsedId.data);
}

export function listConversationResults(
  ownerId: string,
  conversationId: string,
  database: Database.Database = db,
): CanonicalResult[] {
  return resultsQueries.listByConversation(database, ownerId, conversationId);
}

export function listResultContextEdges(
  ownerId: string,
  resultId: string,
  database: Database.Database = db,
) {
  return resultContextEdgesQueries.listByResult(database, ownerId, resultId);
}

export function listResultsBuiltOn(
  ownerId: string,
  sourceResultId: string,
  database: Database.Database = db,
): CanonicalResult[] {
  return resultsQueries.listBySourceResult(database, ownerId, sourceResultId);
}
