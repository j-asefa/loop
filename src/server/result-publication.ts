import type Database from "better-sqlite3";
import { Problem } from "../shared/problem.js";
import {
  collapseResultTitle,
  messageResultId,
  PublishResultInputSchema,
  replyResultId,
  RequestedResultContextSchema,
  ResultIdSchema,
  resultSchemaVersion,
  runResultId,
  type CanonicalResult,
  type PublishResultInput,
  type RequestedResultContext,
  type ResultAttachmentRef,
  type ResultId,
  type ResultOrigin,
  type ResultOriginCompleteness,
  type ResultPlacement,
  type ResultProvenance,
  type ResultStimulus,
  type ResultSupplyItem,
  UNKNOWN_RESULT_PLACEMENT,
} from "../shared/result.js";
import { computeResultContentDigest } from "./result-digest.js";
import { parseCanonicalResult } from "./row-schemas.js";
import * as foldersQueries from "./sql/folders.js";
import * as resultsQueries from "./sql/results.js";
import * as resultContextEdgesQueries from "./sql/result-context-edges.js";

export const MAX_RESULT_SUPPLY_ITEMS = 6;
export const MAX_RESULT_SUPPLY_CHARS = 2_400;
export const MAX_TOTAL_RESULT_SUPPLY_CHARS = 7_200;

type SnapshotMessage = NonNullable<
  ReturnType<typeof resultsQueries.messageById>
>;

function isEligibleAnswerMessage(message: SnapshotMessage): boolean {
  if (message.role !== "assistant") return false;
  if (message.content.trim().length === 0) return false;
  const meta = message.metadata;
  if (meta.progress === true || meta.partial === true) {
    return false;
  }
  return true;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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

// Placement at publication time. The run records the folder it executed in;
// a conversation's folder is only the fallback when the run recorded none.
function placementSnapshot(
  ownerId: string,
  conversation: { project_id: string | null; team_id: string | null },
  run: { payload: { folderId?: string | null } } | undefined,
  database: Database.Database,
): ResultPlacement {
  const folderId =
    run && run.payload.folderId !== undefined
      ? run.payload.folderId
      : conversation.project_id;
  const project = foldersQueries.projectFor(database, {
    owner: ownerId,
    folder: folderId ?? null,
  });
  return {
    status: "recorded",
    folderId: folderId ?? null,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    teamId: conversation.team_id,
  };
}

// The provider that actually executed the run is a recorded fact on the run.
// The agent's current provider is only a fallback for runs that predate it.
function executionProvider(
  run: { payload: { provider?: unknown } } | undefined,
  agent: { provider: string } | undefined,
): string | null {
  return readNonEmptyString(run?.payload.provider) || agent?.provider || null;
}

type ResultAuthorship = Pick<
  ResultProvenance,
  | "agentId"
  | "agentName"
  | "provider"
  | "model"
  | "resolvedModel"
  | "connectionId"
  | "placement"
>;

const MAX_COPY_DEPTH = 32;

type CopiedAnswerSource = ResultAuthorship & {
  origin: Extract<ResultOrigin, { kind: "copied" }>;
  // What establishes the author: a sealed Result of the original (or one
  // that recorded its origin), the source's run, only its conversation's
  // current agent, a version 1 copy whose own source is gone, or nothing.
  evidence: "sealed" | "run" | "conversation" | "unoriginated_copy" | "none";
};

const UNKNOWN_AUTHORSHIP: ResultAuthorship = {
  agentId: null,
  agentName: null,
  provider: null,
  model: null,
  resolvedModel: null,
  connectionId: null,
  placement: UNKNOWN_RESULT_PLACEMENT,
};

function sealedAuthorship(result: CanonicalResult): ResultAuthorship {
  const p = result.provenance;
  return {
    agentId: p.agentId,
    agentName: p.agentName,
    provider: p.provider,
    model: p.model,
    resolvedModel: p.resolvedModel,
    connectionId: p.connectionId,
    placement: p.placement,
  };
}

// A copied answer keeps the author that produced it, not the agent of the
// conversation it was copied into, and names the original it came from.
// Copies point at their source through `sourceMessage`. The walk stops at the
// first sealed Result that records its own origin, or at the original message,
// which is attributed from its own run or conversation. A nested copy inherits
// its source copy's root, so intermediaries never replace the original.
// Version 1 copies recorded no origin, so the walk continues past them to the
// evidence they were sealed from. When the source no longer exists, the author
// is unknown. Lookups are owner-scoped: another owner's IDs read as missing.
export function copiedAnswerEvidence(
  ownerId: string,
  message: SnapshotMessage,
  database: Database.Database,
): CopiedAnswerSource | null {
  let sourceId = readNonEmptyString(message.metadata.sourceMessage);
  if (!sourceId) return null;
  let sourceConversationId = readNonEmptyString(
    message.metadata.sourceConversation,
  );
  const seen = new Set<string>();
  // The nearest version 1 copy passed on the way; it is the best remaining
  // evidence when the chain beyond it is gone.
  let unoriginated: CanonicalResult | undefined;
  while (sourceId && !seen.has(sourceId) && seen.size < MAX_COPY_DEPTH) {
    seen.add(sourceId);
    const source = resultsQueries.messageById(database, ownerId, sourceId);
    const sealed = resultsQueries.canonicalByMessage(
      database,
      ownerId,
      sourceId,
    );
    const next = source
      ? readNonEmptyString(source.metadata.sourceMessage)
      : null;
    if (sealed) {
      const origin = sealed.provenance.origin;
      if (origin?.kind === "copied") {
        return { ...sealedAuthorship(sealed), origin, evidence: "sealed" };
      }
      // A version 1 imported answer whose message is gone may itself have
      // been a copy; it is kept only as the weakest remaining evidence.
      const unverifiable =
        origin === undefined && !source && sealed.kind === "imported_answer";
      if (unverifiable) unoriginated ??= sealed;
      if (!unverifiable && (origin !== undefined || !next)) {
        return {
          ...sealedAuthorship(sealed),
          // It recorded its origin or seals an original. A version 1 imported
          // original took its author from its conversation's agent then.
          evidence:
            origin === undefined && sealed.kind === "imported_answer"
              ? "conversation"
              : "sealed",
          origin: {
            kind: "copied",
            sourceResultId: sealed.id,
            sourceMessageId: sealed.provenance.messageId,
            sourceConversationId: sealed.provenance.conversationId,
            sourceAvailable: true,
          },
        };
      }
    }
    if (!source) break;
    if (next) {
      if (sealed) unoriginated ??= sealed;
      sourceConversationId =
        readNonEmptyString(source.metadata.sourceConversation) ??
        sourceConversationId;
      sourceId = next;
      continue;
    }
    const conversation = resultsQueries.conversationSummary(
      database,
      ownerId,
      source.conversation_id,
    );
    if (!conversation) break;
    const run = source.run_id
      ? resultsQueries.runRow(database, ownerId, source.run_id)
      : undefined;
    const agentId = run?.agent_id ?? conversation.agent_id ?? null;
    const agent = agentId
      ? resultsQueries.agentSummary(database, ownerId, agentId)
      : undefined;
    return {
      agentId,
      agentName:
        readNonEmptyString(agent?.name) ||
        readNonEmptyString(run?.payload.name) ||
        null,
      provider: executionProvider(run, agent),
      model: readNonEmptyString(run?.payload.model) || agent?.model || null,
      resolvedModel:
        readNonEmptyString(run?.payload.resolvedModel) ||
        readResolvedModelFromRunResult(run?.result),
      connectionId:
        readNonEmptyString(run?.payload.connectionId) ||
        conversation.execution_connection_id ||
        agent?.connection_id ||
        null,
      // The source was never sealed, so where it was published is unknown;
      // its run's folder, project and team may all have changed since.
      placement: UNKNOWN_RESULT_PLACEMENT,
      origin: {
        kind: "copied",
        sourceResultId: null,
        sourceMessageId: source.id,
        sourceConversationId: source.conversation_id,
        sourceAvailable: true,
      },
      evidence: run?.agent_id ? "run" : "conversation",
    };
  }
  if (unoriginated) {
    return {
      ...sealedAuthorship(unoriginated),
      evidence: "unoriginated_copy",
      origin: {
        kind: "copied",
        sourceResultId: unoriginated.id,
        sourceMessageId: unoriginated.provenance.messageId,
        sourceConversationId: unoriginated.provenance.conversationId,
        sourceAvailable: true,
      },
    };
  }
  return {
    ...UNKNOWN_AUTHORSHIP,
    evidence: "none",
    origin: {
      kind: "copied",
      sourceResultId: null,
      sourceMessageId: sourceId,
      sourceConversationId,
      sourceAvailable: false,
    },
  };
}

// Conversations created by an external import name their provider in their
// origin, for example `openai-import`.
function externalImportProvider(origin: string): string | null {
  const match = /^([a-z0-9]+)-import$/.exec(origin);
  return match ? match[1] : null;
}

// An imported answer's question is the nearest user message on its own
// branch. OpenAI exports keep every branch with parent node pointers, so the
// chronologically latest question can belong to a different branch. Walking
// the pointers finds the right one; dropped nodes (tool calls) are bridged
// through their stored parent's `children`. Messages without parent pointers,
// or whose chain cannot be followed, keep the chronological rule.
function importedStimulusResolver(
  ownerId: string,
  conversationId: string,
  database: Database.Database,
): (message: SnapshotMessage) => SnapshotMessage | undefined {
  let index: {
    byNode: Map<string, SnapshotMessage>;
    storedParentOf: Map<string, string>;
  } | null = null;
  const build = () => {
    const byNode = new Map<string, SnapshotMessage>();
    const storedParentOf = new Map<string, string>();
    for (const m of resultsQueries.standaloneMessages(
      database,
      ownerId,
      conversationId,
    )) {
      const raw = m.metadata.raw;
      const rawRecord =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      const nodeId =
        readNonEmptyString(rawRecord?.nodeId) ||
        readNonEmptyString(m.metadata.externalId);
      if (!nodeId) continue;
      byNode.set(nodeId, m);
      const externalId = readNonEmptyString(m.metadata.externalId);
      if (externalId && !byNode.has(externalId)) byNode.set(externalId, m);
      const children = rawRecord?.children;
      if (Array.isArray(children)) {
        for (const child of children) {
          if (typeof child === "string" && !storedParentOf.has(child)) {
            storedParentOf.set(child, nodeId);
          }
        }
      }
    }
    return { byNode, storedParentOf };
  };
  const chronological = (message: SnapshotMessage) =>
    resultsQueries.precedingStandaloneUserMessage(
      database,
      ownerId,
      conversationId,
      message.id,
    );
  return (message) => {
    if (message.metadata.parent === undefined) return chronological(message);
    index ??= build();
    const seen = new Set<string>();
    let current = message.metadata.parent;
    while (current) {
      if (seen.has(current)) return chronological(message);
      seen.add(current);
      const node = index.byNode.get(current);
      if (node) {
        if (node.role === "user") return node;
        current = node.metadata.parent ?? null;
        continue;
      }
      const bridged = index.storedParentOf.get(current);
      if (!bridged) return chronological(message);
      current = bridged;
    }
    // The branch root was reached without a question.
    return undefined;
  };
}

function chainParent(
  ownerId: string,
  conversationId: string,
  resultId: ResultId,
  createdAt: number,
  database: Database.Database,
): ResultId | null {
  // A retry that resumes an unsealed draft keeps the predecessor it chose.
  const draft = resultsQueries.byId(database, ownerId, resultId);
  if (draft && draft.sealed === 0) {
    try {
      const prior = JSON.parse(draft.lineage) as { parentResultId?: unknown };
      if (prior.parentResultId === null) return null;
      const parsed = ResultIdSchema.safeParse(prior.parentResultId);
      if (parsed.success) return parsed.data;
    } catch {
      // fall through to a fresh choice
    }
  }
  const row = resultsQueries.precedingResult(
    database,
    ownerId,
    conversationId,
    resultId,
    createdAt,
  );
  return row ? ResultIdSchema.parse(row.id) : null;
}

export function snapshotMessageAttachments(
  ownerId: string,
  message: SnapshotMessage,
  database: Database.Database,
): ResultAttachmentRef[] {
  const rawAttachments = message.metadata.attachments;
  if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) {
    return [];
  }
  const refs: ResultAttachmentRef[] = [];
  for (const item of rawAttachments) {
    if (!item || typeof item.id !== "string" || !item.id) continue;
    const artifact = resultsQueries.artifactById(database, ownerId, item.id);
    if (!artifact) continue;
    const artMeta = artifact.metadata as {
      objectId?: unknown;
      mime?: unknown;
      size?: unknown;
    };
    const candidateObjectId =
      typeof artMeta.objectId === "string" && artMeta.objectId.length > 0
        ? artMeta.objectId
        : null;
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
      artifact.title?.trim() ||
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
  database: Database.Database,
  completeness: ResultOriginCompleteness = "sealed_at_publication",
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
        schema_version: resultSchemaVersion(parsed.provenance),
        kind: parsed.kind,
        origin_completeness: completeness,
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
  database: Database.Database,
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
  database: Database.Database,
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
  const automationKind: string | null =
    triggerMessage?.metadata.automation?.kind ?? null;
  const automationFrom = triggerMessage?.metadata.automation?.fromName ?? null;

  let stimulusKind: ResultStimulus["kind"] = "user_prompt";
  let authorKind: ResultStimulus["authorKind"] = "owner";
  if (
    automationKind === "agent_message" ||
    automationKind === "agent_result" ||
    automationKind === "agent_ping"
  ) {
    stimulusKind = "delegation";
    authorKind = "agent";
  } else if (
    automationKind === "feed_digest" ||
    automationKind === "schedule"
  ) {
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
  const agentName =
    readNonEmptyString(agent?.name) ||
    readNonEmptyString(run.payload.name) ||
    null;
  const model = readNonEmptyString(run.payload.model) || agent?.model || null;
  const resolvedModel =
    readNonEmptyString(run.payload.resolvedModel) ||
    readResolvedModelFromRunResult(run.result);
  const connectionId =
    readNonEmptyString(run.payload.connectionId) ||
    conversation.execution_connection_id ||
    agent?.connection_id ||
    null;

  const createdAt = Math.max(
    0,
    Math.trunc(run.updated_at ?? answer.created_at ?? run.created_at),
  );
  const parentResultId = chainParent(
    ownerId,
    run.conversation_id,
    id,
    createdAt,
    database,
  );

  return publishResult(
    {
      id,
      ownerId,
      kind: "run_answer",
      createdAt,
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
          run.input.trim() ? run.input : answer.content,
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
        provider: executionProvider(run, agent),
        model,
        resolvedModel,
        connectionId,
        conversationId: run.conversation_id,
        runId: run.id,
        messageId: answer.id,
        placement: placementSnapshot(ownerId, conversation, run, database),
        origin: { kind: "produced" },
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
  database: Database.Database,
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
  const agentName =
    readNonEmptyString(agent?.name) ||
    readNonEmptyString(run?.payload.name) ||
    null;
  const model = readNonEmptyString(run?.payload.model) || agent?.model || null;
  const resolvedModel =
    readNonEmptyString(run?.payload.resolvedModel) ||
    readResolvedModelFromRunResult(run?.result);
  const connectionId =
    readNonEmptyString(run?.payload.connectionId) ||
    conversation.execution_connection_id ||
    agent?.connection_id ||
    null;
  const questionText = steering?.question_content ?? null;
  const questionId = steering?.question_id ?? null;
  const createdAt = Math.max(
    0,
    Math.trunc(options.createdAt ?? message.created_at),
  );
  const parentResultId = chainParent(
    options.ownerId,
    message.conversation_id,
    id,
    createdAt,
    database,
  );

  return publishResult(
    {
      id,
      ownerId: options.ownerId,
      kind: "steering_reply",
      createdAt,
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
          questionText?.trim() ? questionText : message.content,
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
        provider: executionProvider(run, agent),
        model,
        resolvedModel,
        connectionId,
        conversationId: message.conversation_id,
        runId,
        messageId: message.id,
        placement: placementSnapshot(
          options.ownerId,
          conversation,
          run,
          database,
        ),
        origin: { kind: "produced" },
      },
      lineage: {
        parentResultId,
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
  database: Database.Database,
): CanonicalResult[] {
  return publishStandaloneAnswers(
    ownerId,
    conversationId,
    "sealed_at_publication",
    database,
  );
}

// Seals standalone answers that existed before canonical Results, during the
// upgrade that introduces them. The policy is the live one; only facts that
// were never recorded differ: the placement at publication time is unknown.
export function publishHistoricalConversationResults(
  ownerId: string,
  conversationId: string,
  database: Database.Database,
): CanonicalResult[] {
  return publishStandaloneAnswers(
    ownerId,
    conversationId,
    "migrated_backfill",
    database,
  );
}

function publishStandaloneAnswers(
  ownerId: string,
  conversationId: string,
  completeness: ResultOriginCompleteness,
  database: Database.Database,
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
  const agentName = readNonEmptyString(agent?.name);

  const messages = resultsQueries.standaloneAssistantMessages(
    database,
    ownerId,
    conversationId,
  );
  const published: CanonicalResult[] = [];
  const stimulusFor = importedStimulusResolver(
    ownerId,
    conversationId,
    database,
  );

  for (const message of messages) {
    if (!isEligibleAnswerMessage(message)) continue;
    const id = messageResultId(message.id);
    const existing = resultsQueries.byId(database, ownerId, id);
    if (existing && existing.sealed === 1) {
      published.push(parseCanonicalResult(existing));
      continue;
    }
    const prompt = stimulusFor(message);
    const promptText = prompt?.content ?? null;
    const promptId = prompt?.id ?? null;
    const createdAt = Math.max(0, Math.trunc(message.created_at));
    // The predecessor is the latest sealed Result of any kind before this
    // answer, so an answer appended after a run chains to that run.
    const parentResultId = chainParent(
      ownerId,
      conversationId,
      id,
      createdAt,
      database,
    );
    const copied = copiedAnswerEvidence(ownerId, message, database);
    const importProvider = externalImportProvider(conversation.origin);
    const origin: ResultOrigin = copied
      ? copied.origin
      : conversation.origin.endsWith("import")
        ? { kind: "external_import", provider: importProvider }
        : { kind: "unknown" };
    const authorship: ResultAuthorship = copied ?? {
      agentId,
      agentName,
      provider: agent?.provider ?? null,
      model: agent?.model ?? null,
      resolvedModel: null,
      connectionId:
        conversation.execution_connection_id ?? agent?.connection_id ?? null,
      placement:
        completeness === "migrated_backfill"
          ? UNKNOWN_RESULT_PLACEMENT
          : placementSnapshot(ownerId, conversation, undefined, database),
    };

    const result = publishResult(
      {
        id,
        ownerId,
        kind: "imported_answer",
        createdAt,
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
            promptText?.trim() ? promptText : message.content,
            conversation.title || "Result",
            200,
          ),
          body: message.content,
          format: "markdown",
        },
        attachments: snapshotMessageAttachments(ownerId, message, database),
        provenance: {
          agentId: authorship.agentId,
          agentName: authorship.agentName,
          provider: authorship.provider,
          model: authorship.model,
          resolvedModel: authorship.resolvedModel,
          connectionId: authorship.connectionId,
          placement: authorship.placement,
          conversationId,
          runId: null,
          messageId: message.id,
          origin,
        },
        lineage: {
          parentResultId,
          triggerMessageId: promptId,
          suppliedContext: [],
        },
      },
      database,
      completeness,
    );
    published.push(result);
  }

  return published;
}

export function getResult(
  ownerId: string,
  resultId: string,
  database: Database.Database,
): CanonicalResult | undefined {
  const parsedId = ResultIdSchema.safeParse(resultId);
  if (!parsedId.success) return undefined;
  return resultsQueries.canonicalById(database, ownerId, parsedId.data);
}

export function listConversationResults(
  ownerId: string,
  conversationId: string,
  database: Database.Database,
): CanonicalResult[] {
  return resultsQueries.listByConversation(database, ownerId, conversationId);
}

export function listResultContextEdges(
  ownerId: string,
  resultId: string,
  database: Database.Database,
) {
  return resultContextEdgesQueries.listByResult(database, ownerId, resultId);
}

export function listResultsBuiltOn(
  ownerId: string,
  sourceResultId: string,
  database: Database.Database,
): CanonicalResult[] {
  return resultsQueries.listBySourceResult(database, ownerId, sourceResultId);
}
