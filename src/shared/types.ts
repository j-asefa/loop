import type { harnesses, Harness } from "./harnesses";
export type Provider = "openai" | (typeof harnesses)[Harness]["provider"];
export type Agent = import("zod").infer<
  typeof import("./workspace-api.js").PublicAgent
>;
export type CreatedAgent = Agent & {
  initialRun?: { id: string; conversation_id: string | null };
};
export type Connection = import("zod").infer<
  typeof import("./workspace-api.js").PublicConnection
>;
export type Message = import("zod").infer<
  typeof import("./workspace-api.js").PublicMessage
>;
export type Artifact = import("zod").infer<
  typeof import("./workspace-api.js").PublicArtifact
>;
export type Folder = import("zod").infer<
  typeof import("./workspace-api.js").PublicFolder
>;
/** Public serialized wire projection; storage Run is server-only. */
export type RunView = import("zod").infer<
  typeof import("./workspace-api.js").PublicRun
>;
export type Team = import("zod").infer<
  typeof import("./workspace-api.js").PublicTeam
>;
