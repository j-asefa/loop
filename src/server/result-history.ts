import type Database from "better-sqlite3";
import { z } from "zod";
import type { CanonicalResult } from "../shared/result.js";
import {
  copiedAnswerEvidence,
  publishHistoricalConversationResults,
} from "./result-publication.js";
import * as resultDefectsQueries from "./sql/result-defects.js";
import * as passesQueries from "./sql/result-history-passes.js";
import * as resultsQueries from "./sql/results.js";

// Historical Results: sealing answers that predate canonical Results, and
// recording where already-sealed records disagree with retained evidence.
// Sealed records are never rewritten; a disagreement is an append-only
// finding beside the original. Passes run once each, inside the migration
// transaction, so concurrent API and worker startups serialize on it. None
// launches a model, reruns work or replays an external effect.

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

// Each finding kind declares the evidence it stores; kinds are listed in
// ResultDefectKindSchema.
const StoredDefectSchema = z.discriminatedUnion("defect", [
  z.object({
    defect: z.literal("copy_attribution"),
    evidence: CopyAttributionEvidenceSchema,
  }),
]);
export type ResultDefect = z.infer<typeof StoredDefectSchema> & {
  detectedAt: number;
};

type Pass = {
  name: string;
  // Whether this pass applies to a database whose canonical results were
  // created by the current migration run (`fresh`) or by an earlier build.
  appliesTo: "fresh" | "existing";
  run: (database: Database.Database, at: number) => void;
};

const passes: Pass[] = [
  {
    // Migration 164 seals run answers and steering replies in SQL. Standalone,
    // imported and copied answers need the live publication policy.
    name: "seal-standalone-answers",
    appliesTo: "fresh",
    run: (database) => {
      for (const row of resultsQueries.historicalAnswerConversations(
        database,
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
  // An unavailable source establishes nothing about the recorded author.
  if (!source || !source.origin.sourceAvailable) return;
  // Names and models can come from an agent's current settings when the
  // source was never sealed, so only the durable agent identity decides.
  if (source.agentId === result.provenance.agentId) return;
  const recorded = author(result.provenance);
  const evidence = author(source);
  recordDefect(database, result, at, {
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

function recordDefect(
  database: Database.Database,
  result: CanonicalResult,
  at: number,
  finding: z.input<typeof StoredDefectSchema>,
) {
  const parsed = StoredDefectSchema.parse(finding);
  const inserted = resultDefectsQueries.insert(database, {
    ownerId: result.ownerId,
    resultId: result.id,
    defect: parsed.defect,
    evidence: JSON.stringify(parsed.evidence),
    detectedAt: at,
  });
  // Done cards present findings, so their projection is rebuilt.
  if (inserted.changes > 0 && result.kind !== "steering_reply") {
    resultsQueries.markFeedCardDirty(
      database,
      result.ownerId,
      result.provenance.conversationId,
      result.id,
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
    if ((pass.appliesTo === "fresh") === options.freshResults) {
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
