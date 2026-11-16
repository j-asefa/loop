import type Database from "better-sqlite3";
import { z } from "zod";
import type { CanonicalResult } from "../shared/result.js";
import {
  copiedAnswerEvidence,
  importedStimulusResolver,
  publishCompletedRunResult,
  publishHistoricalConversationResults,
  publishSteeringReplyResult,
} from "./result-publication.js";
import * as feedCardDirtyQueries from "./sql/feed-card-dirty.js";
import * as resultDefectsQueries from "./sql/result-defects.js";
import * as passesQueries from "./sql/result-history-passes.js";
import * as resultsQueries from "./sql/results.js";

// Historical Results: sealing answers that predate canonical Results, and
// recording where already-sealed records disagree with retained evidence.
// Sealed records are never rewritten; a disagreement is an append-only
// finding beside the original. Passes run once each, inside the migration
// transaction, so concurrent API and worker startups serialize on it. None
// launches a model, reruns work or replays an external effect.
// Answers from releases without Results are sealed with the live publication
// policy and marked `migrated_backfill`. Each publish path records placement
// only from evidence it holds (a run's recorded folder, a copy's source) and
// otherwise leaves it unknown; the conversation's current folder is never
// used as evidence of where an answer ran.

const AuthorEvidenceSchema = z.object({
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
});

export const CopyAttributionEvidenceSchema = z.object({
  recorded: AuthorEvidenceSchema,
  source: AuthorEvidenceSchema.extend({
    available: z.boolean(),
    sourceResultId: z.string().nullable(),
    sourceMessageId: z.string(),
  }),
});

// The question recorded for an imported answer versus the one its export
// branch identifies; `none` means the branch has no question.
export const ImportStimulusEvidenceSchema = z.object({
  recordedSourceMessageId: z.string().nullable(),
  branch: z.enum(["question", "none"]),
  branchSourceMessageId: z.string().nullable(),
});

// The predecessor recorded for an imported answer versus the latest Result
// published before it in the canonical sequence.
export const SequencePredecessorEvidenceSchema = z.object({
  recordedParentResultId: z.string().nullable(),
  sequenceParentResultId: z.string().nullable(),
});

// Each finding kind declares the evidence it stores; kinds are listed in
// ResultDefectKindSchema.
const StoredDefectSchema = z.discriminatedUnion("defect", [
  z.object({
    defect: z.literal("copy_attribution"),
    evidence: CopyAttributionEvidenceSchema,
  }),
  z.object({
    defect: z.literal("import_stimulus"),
    evidence: ImportStimulusEvidenceSchema,
  }),
  z.object({
    defect: z.literal("sequence_predecessor"),
    evidence: SequencePredecessorEvidenceSchema,
  }),
]);
export type ResultDefect = z.infer<typeof StoredDefectSchema> & {
  detectedAt: number;
};

// Copies name the original Result they came from, so a source conversation
// is sealed before the conversations copied from it. Creation order breaks
// ties; a dependency cycle (not produced by any writer) falls back to it.
function sealingOrder<
  T extends { owner_id: string; conversation_id: string; sources: string[] },
>(rows: T[]): T[] {
  const key = (owner: string, conversation: string) =>
    owner + "\u001f" + conversation;
  const byKey = new Map(
    rows.map((row) => [key(row.owner_id, row.conversation_id), row]),
  );
  const ordered: T[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (row: T) => {
    const id = key(row.owner_id, row.conversation_id);
    if (state.has(id)) return;
    state.set(id, "visiting");
    for (const source of row.sources) {
      const dependency = byKey.get(key(row.owner_id, source));
      if (dependency) visit(dependency);
    }
    state.set(id, "done");
    ordered.push(row);
  };
  for (const row of rows) visit(row);
  return ordered;
}

type Pass = {
  name: string;
  // Whether this pass applies to a database whose canonical results were
  // created by the current migration run (`fresh`) or by an earlier build.
  appliesTo: "fresh" | "existing" | "any";
  run: (database: Database.Database, at: number) => void;
};

const passes: Pass[] = [
  {
    // Migration 164 seals run answers and steering replies in SQL. Standalone,
    // imported and copied answers need the live publication policy.
    name: "seal-standalone-answers",
    appliesTo: "fresh",
    run: (database) => {
      for (const row of sealingOrder(
        resultsQueries.historicalAnswerConversations(database),
      )) {
        publishHistoricalConversationResults(
          row.owner_id,
          row.conversation_id,
          database,
        );
      }
      resultsQueries.chainPendingBackfill(database);
    },
  },
  {
    // Builds before sealed origins could attribute a copied answer to the
    // agent of the conversation it was copied into.
    name: "detect-copy-attribution",
    appliesTo: "existing",
    run: (database, at) => {
      for (const result of resultsQueries.unoriginatedCopies(database)) {
        detectCopyAttribution(result, database, at);
      }
    },
  },
  {
    // Builds before branch-aware stimulus took an imported answer's question
    // from the chronologically latest user message, which in a branched
    // export can belong to another branch.
    name: "detect-import-stimulus",
    appliesTo: "existing",
    run: (database, at) => {
      const resolvers = new Map<
        string,
        ReturnType<typeof importedStimulusResolver>
      >();
      for (const result of resultsQueries.branchedImportedResults(database)) {
        const key = `${result.ownerId}\u001f${result.provenance.conversationId}`;
        let resolve = resolvers.get(key);
        if (!resolve) {
          resolve = importedStimulusResolver(
            result.ownerId,
            result.provenance.conversationId,
            database,
          );
          resolvers.set(key, resolve);
        }
        const message = resultsQueries.messageById(
          database,
          result.ownerId,
          result.provenance.messageId,
        );
        if (!message) continue;
        const branch = resolve(message);
        // A branch that cannot be followed establishes nothing about the
        // recorded question.
        if (branch.kind === "unknown") continue;
        const branchSourceMessageId =
          branch.kind === "question" ? branch.message.id : null;
        if (branchSourceMessageId === result.stimulus.sourceMessageId) continue;
        recordDefect(database, findingTarget(result), at, {
          defect: "import_stimulus",
          evidence: {
            recordedSourceMessageId: result.stimulus.sourceMessageId,
            branch: branch.kind,
            branchSourceMessageId,
          },
        });
      }
    },
  },
  {
    // Builds before the cross-kind sequence chained an appended imported
    // answer to the previous imported answer, skipping intervening runs.
    name: "detect-import-sequence",
    appliesTo: "existing",
    run: (database, at) => {
      for (const row of resultsQueries.importedSequence(database)) {
        if (row.recorded === row.expected) continue;
        recordDefect(
          database,
          {
            ownerId: row.owner_id,
            resultId: row.id,
            conversationId: row.conversation_id,
            kind: "imported_answer",
          },
          at,
          {
            defect: "sequence_predecessor",
            evidence: {
              recordedParentResultId: row.recorded,
              sequenceParentResultId: row.expected,
            },
          },
        );
      }
    },
  },
  {
    // Done and Replies read only sealed Results. Earlier builds still listed
    // answers that had none, such as native session imports, so those are
    // sealed now from the evidence that listed them.
    name: "seal-unpublished-answers",
    appliesTo: "existing",
    run: (database) => sealUnpublishedAnswers(database),
  },
  {
    // Result cards are rebuilt from the Results they display, under current
    // folder organization.
    name: "rebuild-result-cards",
    appliesTo: "any",
    run: (database) => {
      feedCardDirtyQueries.markResultConversationsDirty(database);
    },
  },
];

function author(p: {
  agentId: string | null;
  agentName: string | null;
  provider: string | null;
  model: string | null;
}) {
  return {
    agentId: p.agentId,
    agentName: p.agentName,
    provider: p.provider,
    model: p.model,
  };
}

function detectCopyAttribution(
  result: CanonicalResult,
  database: Database.Database,
  at: number,
) {
  const message = resultsQueries.messageById(
    database,
    result.ownerId,
    result.provenance.messageId,
  );
  if (!message) return;
  const source = copiedAnswerEvidence(result.ownerId, message, database);
  // Only a Result that recorded its origin, or the source's run, establishes
  // its author. A conversation's agent can change, a version 1 copy is the
  // kind of record being checked, and a missing source establishes nothing.
  if (!source || (source.evidence !== "sealed" && source.evidence !== "run"))
    return;
  // Names and models can come from an agent's current settings when the
  // source was never sealed, so only the durable agent identity decides.
  if (source.agentId === result.provenance.agentId) return;
  const recorded = author(result.provenance);
  const evidence = author(source);
  recordDefect(database, findingTarget(result), at, {
    defect: "copy_attribution",
    evidence: {
      recorded,
      source: {
        ...evidence,
        available: source.origin.sourceAvailable,
        sourceResultId: source.origin.sourceResultId,
        sourceMessageId: source.origin.sourceMessageId,
      },
    },
  });
}

type FindingTarget = {
  ownerId: string;
  resultId: string;
  conversationId: string;
  kind: CanonicalResult["kind"];
};

function findingTarget(result: CanonicalResult): FindingTarget {
  return {
    ownerId: result.ownerId,
    resultId: result.id,
    conversationId: result.provenance.conversationId,
    kind: result.kind,
  };
}

function recordDefect(
  database: Database.Database,
  target: FindingTarget,
  at: number,
  finding: z.input<typeof StoredDefectSchema>,
) {
  const parsed = StoredDefectSchema.parse(finding);
  const inserted = resultDefectsQueries.insert(database, {
    ownerId: target.ownerId,
    resultId: target.resultId,
    defect: parsed.defect,
    evidence: JSON.stringify(parsed.evidence),
    detectedAt: at,
  });
  // Done cards present findings, so their projection is rebuilt.
  if (inserted.changes > 0 && target.kind !== "steering_reply") {
    resultsQueries.markFeedCardDirty(
      database,
      target.ownerId,
      target.conversationId,
      target.resultId,
    );
  }
}

// Seals, as migrated history, answers that an earlier build listed without a
// Result: completed runs, published steering replies and standalone answers.
// Each publication is idempotent and keeps existing sealed Results.
export function sealUnpublishedAnswers(database: Database.Database) {
  for (const run of resultsQueries.unpublishedCompletedRuns(database)) {
    publishCompletedRunResult(
      run.id,
      run.owner_id,
      database,
      "migrated_backfill",
    );
  }
  for (const reply of resultsQueries.unpublishedReplies(database)) {
    publishSteeringReplyResult(
      {
        ownerId: reply.owner_id,
        messageId: reply.message_id,
        steeringId: reply.steering_id,
        createdAt: reply.created_at,
      },
      database,
      "migrated_backfill",
    );
  }
  for (const row of resultsQueries.historicalAnswerConversations(database)) {
    publishHistoricalConversationResults(
      row.owner_id,
      row.conversation_id,
      database,
    );
  }
}

export function runResultHistoryPasses(
  database: Database.Database,
  options: { freshResults: boolean; now?: number },
) {
  const at = options.now ?? Date.now();
  for (const pass of passes) {
    if (passesQueries.applied(database, pass.name)) continue;
    if (
      pass.appliesTo === "any" ||
      (pass.appliesTo === "fresh") === options.freshResults
    ) {
      pass.run(database, at);
    }
    passesQueries.record(database, pass.name, at);
  }
}

export function resultDefects(
  ownerId: string,
  resultId: string,
  database: Database.Database,
): ResultDefect[] {
  return resultDefectsQueries
    .listByResult(database, ownerId, resultId)
    .map((row) => ({
      ...StoredDefectSchema.parse({
        defect: row.defect,
        evidence: JSON.parse(row.evidence),
      }),
      detectedAt: row.detected_at,
    }));
}
