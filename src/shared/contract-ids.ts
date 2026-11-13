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

export const NativeCatalogId = z.string().brand<"NativeCatalogId">();
export type NativeCatalogId = z.output<typeof NativeCatalogId>;
export const NativeDecisionId = z.string().brand<"NativeDecisionId">();
export type NativeDecisionId = z.output<typeof NativeDecisionId>;

export const NativeProviderId = z.string().brand<"NativeProviderId">();
export type NativeProviderId = z.output<typeof NativeProviderId>;
export const AuthMethodId = z.string().brand<"AuthMethodId">();
export type AuthMethodId = z.output<typeof AuthMethodId>;
export const AuthAttemptId = z.string().brand<"AuthAttemptId">();
export type AuthAttemptId = z.output<typeof AuthAttemptId>;
export const AuthPromptId = z.string().brand<"AuthPromptId">();
export type AuthPromptId = z.output<typeof AuthPromptId>;
export const AuthOptionId = z.string().brand<"AuthOptionId">();
export type AuthOptionId = z.output<typeof AuthOptionId>;

export const ExecutionCommandId = z.string().brand<"ExecutionCommandId">();
export type ExecutionCommandId = z.output<typeof ExecutionCommandId>;

export const ModelId = z.string().brand<"ModelId">();
export type ModelId = z.output<typeof ModelId>;

export const SteeringId = z.string().brand<"SteeringId">();
export type SteeringId = z.output<typeof SteeringId>;
export const WorkerId = z.string().brand<"WorkerId">();
export type WorkerId = z.output<typeof WorkerId>;
export const NativeGenerationId = z.string().brand<"NativeGenerationId">();
export type NativeGenerationId = z.output<typeof NativeGenerationId>;
export const NativeRequestId = z.string().brand<"NativeRequestId">();
export type NativeRequestId = z.output<typeof NativeRequestId>;
export const NativeItemId = z.string().brand<"NativeItemId">();
export type NativeItemId = z.output<typeof NativeItemId>;
export const SessionSettingId = z.string().brand<"SessionSettingId">();
export type SessionSettingId = z.output<typeof SessionSettingId>;
export const ExecutionGenerationId = z
  .string()
  .brand<"ExecutionGenerationId">();
export type ExecutionGenerationId = z.output<typeof ExecutionGenerationId>;
export const ExecutionRequestId = z.string().brand<"ExecutionRequestId">();
export type ExecutionRequestId = z.output<typeof ExecutionRequestId>;

export const ActivityId = z.string().brand<"ActivityId">();
export type ActivityId = z.output<typeof ActivityId>;
export const ActivityKey = z.string().brand<"ActivityKey">();
export type ActivityKey = z.output<typeof ActivityKey>;
export const PlanStepId = z.string().brand<"PlanStepId">();
export type PlanStepId = z.output<typeof PlanStepId>;
export const CatalogCommandId = z.string().brand<"CatalogCommandId">();
export type CatalogCommandId = z.output<typeof CatalogCommandId>;
export const ToolCallId = z.string().brand<"ToolCallId">();
export type ToolCallId = z.output<typeof ToolCallId>;
export const TerminalId = z.string().brand<"TerminalId">();
export type TerminalId = z.output<typeof TerminalId>;
export const TraceKey = z.string().brand<"TraceKey">();
export type TraceKey = z.output<typeof TraceKey>;
export const OperationId = z.string().brand<"OperationId">();
export type OperationId = z.output<typeof OperationId>;
export const TraceId = z.number().brand<"TraceId">();
export type TraceId = z.output<typeof TraceId>;

// Remaining transport identities keep each field’s existing runtime validators.
export const PairedDeviceId = z.string().brand<"PairedDeviceId">();
export type PairedDeviceId = z.output<typeof PairedDeviceId>;
export const AgentSourceId = z.string().brand<"AgentSourceId">();
export type AgentSourceId = z.output<typeof AgentSourceId>;
export const WorkspaceSubscriptionId = z
  .string()
  .brand<"WorkspaceSubscriptionId">();
export type WorkspaceSubscriptionId = z.output<typeof WorkspaceSubscriptionId>;
export const WorkspaceEpochId = z.string().brand<"WorkspaceEpochId">();
export type WorkspaceEpochId = z.output<typeof WorkspaceEpochId>;
export const BuildId = z.string().brand<"BuildId">();
export type BuildId = z.output<typeof BuildId>;
export const ProcessInstanceId = z.string().brand<"ProcessInstanceId">();
export type ProcessInstanceId = z.output<typeof ProcessInstanceId>;
export const PreviewBuildId = z.string().brand<"PreviewBuildId">();
export type PreviewBuildId = z.output<typeof PreviewBuildId>;
export const GitCommitId = z.string().brand<"GitCommitId">();
export type GitCommitId = z.output<typeof GitCommitId>;
export const GitHubThreadId = z.string().brand<"GitHubThreadId">();
export type GitHubThreadId = z.output<typeof GitHubThreadId>;
export const EventSubjectId = z.string().brand<"EventSubjectId">();
export type EventSubjectId = z.output<typeof EventSubjectId>;
export const FeedProjectionId = z.string().brand<"FeedProjectionId">();
export type FeedProjectionId = z.output<typeof FeedProjectionId>;
export const PersonalDecisionId = z.string().brand<"PersonalDecisionId">();
export type PersonalDecisionId = z.output<typeof PersonalDecisionId>;
export const SearchDocumentId = z.string().brand<"SearchDocumentId">();
export type SearchDocumentId = z.output<typeof SearchDocumentId>;
export const MemoryOriginId = z.string().brand<"MemoryOriginId">();
export type MemoryOriginId = z.output<typeof MemoryOriginId>;
export const AgentAddressId = z.string().brand<"AgentAddressId">();
export type AgentAddressId = z.output<typeof AgentAddressId>;
export const ExternalConversationId = z
  .string()
  .brand<"ExternalConversationId">();
export type ExternalConversationId = z.output<typeof ExternalConversationId>;
export const MessageUpdateKey = z.string().brand<"MessageUpdateKey">();
export type MessageUpdateKey = z.output<typeof MessageUpdateKey>;
export const IdempotencyKey = z.string().brand<"IdempotencyKey">();
export type IdempotencyKey = z.output<typeof IdempotencyKey>;
export const GitHubPullNumber = z.number().brand<"GitHubPullNumber">();
export type GitHubPullNumber = z.output<typeof GitHubPullNumber>;
export const EventId = z.number().brand<"EventId">();
export type EventId = z.output<typeof EventId>;
export const ViewportSessionId = z.string().brand<"ViewportSessionId">();
export type ViewportSessionId = z.output<typeof ViewportSessionId>;

// These coercing views preserve the original HTTP input behavior exactly.
export const CoercedPairedDeviceId = z.coerce
  .string<string>()
  .brand<"PairedDeviceId", "inout">();
export const CoercedGitHubPullNumber = z.coerce
  .number<string | number>()
  .brand<"GitHubPullNumber", "inout">();
export const LaterTargetId = z.union([
  ConversationId,
  ArtifactId,
  MessageId,
  SocialStoryId,
]);
export type LaterTargetId = z.output<typeof LaterTargetId>;
export const LaterTargetInput = z.union([
  requestId(ConversationId).min(1).max(150),
  requestId(ArtifactId).min(1).max(150),
  requestId(MessageId).min(1).max(150),
  requestId(SocialStoryId).min(1).max(150),
]);

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

// Parse the scalar lookup; the route retains its existing range checks and
// numeric URL normalization. Request bodies and queries remain untouched.
export function parsePullNumber(value: string | number) {
  return CoercedGitHubPullNumber.parse(value);
}
export const GitHubPullNumberInput = GitHubPullNumber.brand<
  "GitHubPullNumber",
  "inout"
>();
