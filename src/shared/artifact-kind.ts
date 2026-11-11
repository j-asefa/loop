import { z } from "zod";

// The one closed set of artifact kinds. A kind stays here only while a
// production code path writes it (D1); the kind says how the content is
// rendered, never what the artifact is (that is `role`, PR 2).
export const ArtifactKinds = [
  "markdown",
  "image",
  "github_pr",
  "chart",
  "table",
  "diagram",
  "file",
  "conversation",
] as const;
export const ArtifactKindSchema = z.enum(ArtifactKinds);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

// Kinds the owner may create directly through the artifacts API. This is a
// subset of ArtifactKindSchema; values with a server-only producer stay out.
export const OwnerArtifactKinds = [
  "markdown",
  "table",
  "diagram",
  "file",
] as const;
export const OwnerArtifactKindSchema = z.enum(OwnerArtifactKinds);
export type OwnerArtifactKind = z.infer<typeof OwnerArtifactKindSchema>;

export const DefaultArtifactKind = "markdown" as const;
