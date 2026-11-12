import { z } from "zod";

// What an artifact *is*. `kind` says how it is drawn; `role` is declared by
// the producer at insert and never inferred later (D2). These six names are
// the owner's; the database enforces the set.
export const ArtifactRoles = [
  "answer",
  "trace",
  "file",
  "upload",
  "import",
  "snippet",
] as const;
export const ArtifactRoleSchema = z.enum(ArtifactRoles);
export type ArtifactRole = z.infer<typeof ArtifactRoleSchema>;

// Roles whose artifacts count as results (D3), derived from today's
// resultOutputSql (`finished AND NOT trace AND NOT upload AND NOT uploaded
// AND NOT partial`): the run's answer once finished, plus published rows with
// no run that carry none of the excluded probes (owner snippets and imports).
// trace/file/upload rows are never selected. SQL and TypeScript share this set.
export const ResultArtifactRoles = ["answer", "snippet", "import"] as const;
export type ResultArtifactRole = (typeof ResultArtifactRoles)[number];
