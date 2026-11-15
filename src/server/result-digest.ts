import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  canonicalResultDigestSerialized,
  collapseResultTitle,
  ResultAttachmentRefSchema,
  ResultKindSchema,
  ResultLineageSchema,
  ResultOutcomeSchema,
  ResultProvenanceSchema,
  ResultStimulusSchema,
  type ResultDigestTarget,
} from "../shared/result.js";
import { z } from "zod";

const registeredDbs = new WeakSet<Database.Database>();

export function computeResultContentDigest(input: ResultDigestTarget): string {
  return createHash("sha256")
    .update(canonicalResultDigestSerialized(input))
    .digest("hex");
}

export function computeResultContentDigestFromRawJson(
  id: string,
  kind: string,
  stimulusJson: string,
  outcomeJson: string,
  attachmentsJson: string,
  provenanceJson: string,
  lineageJson: string,
): string {
  return computeResultContentDigest({
    id,
    kind: ResultKindSchema.parse(kind),
    stimulus: ResultStimulusSchema.parse(JSON.parse(stimulusJson)),
    outcome: ResultOutcomeSchema.parse(JSON.parse(outcomeJson)),
    attachments: z
      .array(ResultAttachmentRefSchema)
      .parse(JSON.parse(attachmentsJson)),
    provenance: ResultProvenanceSchema.parse(JSON.parse(provenanceJson)),
    lineage: ResultLineageSchema.parse(JSON.parse(lineageJson)),
  });
}

export function registerResultSqliteFunctions(db: Database.Database): void {
  if (registeredDbs.has(db)) return;
  db.function(
    "result_title",
    { deterministic: true },
    (
      primaryText: unknown,
      secondaryText: unknown,
      fallbackText: unknown,
    ): string => {
      const first =
        typeof primaryText === "string" && primaryText.trim().length > 0
          ? primaryText
          : typeof secondaryText === "string"
            ? secondaryText
            : "";
      const fallback =
        typeof fallbackText === "string" && fallbackText.trim().length > 0
          ? fallbackText
          : "Result";
      return collapseResultTitle(first, fallback, 200);
    },
  );
  db.function(
    "result_digest",
    { deterministic: true },
    (
      id: unknown,
      kind: unknown,
      stimulusJson: unknown,
      outcomeJson: unknown,
      attachmentsJson: unknown,
      provenanceJson: unknown,
      lineageJson: unknown,
    ): string =>
      computeResultContentDigestFromRawJson(
        String(id ?? ""),
        String(kind ?? "run_answer"),
        String(stimulusJson ?? "{}"),
        String(outcomeJson ?? "{}"),
        String(attachmentsJson ?? "[]"),
        String(provenanceJson ?? "{}"),
        String(lineageJson ?? "{}"),
      ),
  );
  registeredDbs.add(db);
}
