import { z } from "zod";

// Nominal identity does not replace existing field validators. Most request
// IDs were unrestricted strings, so those domains keep that runtime rule.
// Owner labels are fixed companion/profile identities, not necessarily UUIDs.
export const OwnerId = z.string().min(1).max(200).brand<"OwnerId">();
export type OwnerId = z.output<typeof OwnerId>;
export const AgentId = z.string().brand<"AgentId">();
export type AgentId = z.output<typeof AgentId>;
export const ConversationId = z.string().brand<"ConversationId">();
export type ConversationId = z.output<typeof ConversationId>;
export const RunId = z.string().brand<"RunId">();
export type RunId = z.output<typeof RunId>;
export const MessageId = z.string().brand<"MessageId">();
export type MessageId = z.output<typeof MessageId>;
export const ArtifactId = z.string().brand<"ArtifactId">();
export type ArtifactId = z.output<typeof ArtifactId>;
export const ApprovalId = z.string().brand<"ApprovalId">();
export type ApprovalId = z.output<typeof ApprovalId>;
export const TeamId = z.string().brand<"TeamId">();
export type TeamId = z.output<typeof TeamId>;
export const FolderId = z.string().brand<"FolderId">();
export type FolderId = z.output<typeof FolderId>;
export const ConnectionId = z.string().brand<"ConnectionId">();
export type ConnectionId = z.output<typeof ConnectionId>;
// A project is a folder of kind project; it can be used where a folder is
// accepted, while an arbitrary folder is not a project without validation.
export const ProjectId = FolderId.brand<"ProjectId">();
export type ProjectId = z.output<typeof ProjectId>;

// Retain these record fields' existing unrestricted string rule.
export const ImportId = z.string().brand<"ImportId">();
export type ImportId = z.output<typeof ImportId>;
export const ObjectId = z.string().brand<"ObjectId">();
export type ObjectId = z.output<typeof ObjectId>;
export const ScheduledSendId = z.string().brand<"ScheduledSendId">();
export type ScheduledSendId = z.output<typeof ScheduledSendId>;
export const PrWatchId = z.string().brand<"PrWatchId">();
export type PrWatchId = z.output<typeof PrWatchId>;
export const LaterItemId = z.string().brand<"LaterItemId">();
export type LaterItemId = z.output<typeof LaterItemId>;
export const ReviewId = z.string().brand<"ReviewId">();
export type ReviewId = z.output<typeof ReviewId>;
export const CheckoutId = z.string().brand<"CheckoutId">();
export type CheckoutId = z.output<typeof CheckoutId>;
export const VerificationId = z.string().brand<"VerificationId">();
export type VerificationId = z.output<typeof VerificationId>;

export const DefinitionId = z.string().brand<"DefinitionId">();
export type DefinitionId = z.output<typeof DefinitionId>;
export const DoneThreadId = z.string().brand<"DoneThreadId">();
export type DoneThreadId = z.output<typeof DoneThreadId>;
export const MemorySourceId = z.string().brand<"MemorySourceId">();
export type MemorySourceId = z.output<typeof MemorySourceId>;
export const McpConnectionId = z.string().brand<"McpConnectionId">();
export type McpConnectionId = z.output<typeof McpConnectionId>;
export const McpCatalogEntryId = z.string().brand<"McpCatalogEntryId">();
export type McpCatalogEntryId = z.output<typeof McpCatalogEntryId>;
export const McpCandidateId = z.string().brand<"McpCandidateId">();
export type McpCandidateId = z.output<typeof McpCandidateId>;
export const SocialStoryId = z.string().brand<"SocialStoryId">();
export type SocialStoryId = z.output<typeof SocialStoryId>;
export const SocialFeedId = z.string().brand<"SocialFeedId">();
export type SocialFeedId = z.output<typeof SocialFeedId>;
export const SocialWatchId = z.string().brand<"SocialWatchId">();
export type SocialWatchId = z.output<typeof SocialWatchId>;
export const SocialDigestId = z.string().brand<"SocialDigestId">();
export type SocialDigestId = z.output<typeof SocialDigestId>;
export const TeamPresetId = z.string().brand<"TeamPresetId">();
export type TeamPresetId = z.output<typeof TeamPresetId>;
export const TeamRoleId = z.string().brand<"TeamRoleId">();
export type TeamRoleId = z.output<typeof TeamRoleId>;

export const MailId = z.string().brand<"MailId">();
export type MailId = z.output<typeof MailId>;
export const MailThreadId = z.string().brand<"MailThreadId">();
export type MailThreadId = z.output<typeof MailThreadId>;

export const CardTokenId = z.string().brand<"CardTokenId">();
export type CardTokenId = z.output<typeof CardTokenId>;
export const WebhookSubscriptionId = z
  .string()
  .brand<"WebhookSubscriptionId">();
export type WebhookSubscriptionId = z.output<typeof WebhookSubscriptionId>;
export const WebhookDeliveryId = z.string().brand<"WebhookDeliveryId">();
export type WebhookDeliveryId = z.output<typeof WebhookDeliveryId>;
export const WebhookRequestId = z.string().brand<"WebhookRequestId">();
export type WebhookRequestId = z.output<typeof WebhookRequestId>;

type BrandNames<S extends z.ZodType> =
  z.output<S> extends {
    readonly [z.$brand]: infer Marks;
  }
    ? keyof Marks
    : never;

// Request views require the same nominal brand in typed client inputs. Raw
// HTTP is still parsed from unknown. Response schemas retain output-only
// brands so server builders and SQL internals keep supplying plain strings.
export function requestId<S extends z.ZodString>(
  schema: S & (BrandNames<S> extends never ? never : unknown),
) {
  return schema.brand<BrandNames<S>, "inout">();
}

// Parse only the identity value at ingress. Keep null/undefined and every
// other request field unchanged: transport serializes the original inputs.
export function parseId<
  S extends z.ZodString,
  V extends string | null | undefined,
>(
  schema: S & (BrandNames<S> extends never ? never : unknown),
  value: V,
): z.output<S> | Extract<V, null | undefined> {
  if (value == null) return value as Extract<V, null | undefined>;
  return schema.parse(value);
}
