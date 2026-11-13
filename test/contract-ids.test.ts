import * as Remaining from "../src/shared/contract-ids.js";
import * as Multiplex from "../src/shared/workspace-multiplex.js";
import {
  ActivityId,
  ActivityKey,
  PlanStepId,
  CatalogCommandId,
  ToolCallId,
  TerminalId,
  TraceKey,
  TraceId,
  OperationId,
} from "../src/shared/contract-ids.js";
import { ActivityUpdate } from "../src/shared/agent-activities.js";
import { AttachmentIds } from "../src/shared/uploads.js";
import {
  SteeringId,
  WorkerId,
  NativeGenerationId,
  NativeRequestId,
  NativeItemId,
  SessionSettingId,
  ExecutionGenerationId,
  ExecutionRequestId,
} from "../src/shared/contract-ids.js";
import {
  ExecutionReady,
  ExecutionRequest,
} from "../src/shared/execution-authority.js";
import { ModelId } from "../src/shared/contract-ids.js";
import {
  AgentCreateInput,
  AgentUpdateInput,
  PublicModel,
} from "../src/shared/agent-contract-schemas.js";
import { ExecutionCommandId } from "../src/shared/contract-ids.js";
import {
  NativeProviderId,
  AuthMethodId,
  AuthAttemptId,
  AuthPromptId,
  AuthOptionId,
} from "../src/shared/contract-ids.js";
import { WebhookStop } from "../src/shared/webhooks.js";
import { chartSchema } from "../src/shared/chart.js";
import { artifactRefreshSource } from "../src/shared/artifact-refresh.js";
import {
  NativeCatalogId,
  NativeDecisionId,
} from "../src/shared/contract-ids.js";
import { CheckoutSummarySchema } from "../src/shared/checkout.js";
import { VerificationSummarySchema } from "../src/shared/verification.js";
import { DoneDisplaySchema } from "../src/shared/done-card.js";
import { PublicTeam } from "../src/shared/workspace-contract-schemas.js";
import {
  CardTokenId,
  WebhookSubscriptionId,
  WebhookDeliveryId,
  WebhookRequestId,
} from "../src/shared/contract-ids.js";
import { MailId, MailThreadId } from "../src/shared/contract-ids.js";
import {
  DefinitionId,
  DoneThreadId,
  MemorySourceId,
  McpConnectionId,
  McpCatalogEntryId,
  McpCandidateId,
  SocialStoryId,
  SocialFeedId,
  SocialWatchId,
  SocialDigestId,
  TeamPresetId,
  TeamRoleId,
} from "../src/shared/contract-ids.js";
import { expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  ImportId,
  ObjectId,
  ScheduledSendId,
  PrWatchId,
  LaterItemId,
  ReviewId,
  CheckoutId,
  VerificationId,
  OwnerId,
  AgentId,
  ConversationId,
  RunId,
  MessageId,
  ArtifactId,
  ApprovalId,
  TeamId,
  FolderId,
  ProjectId,
  ConnectionId,
  requestId,
  parseId,
} from "../src/shared/contract-ids.js";
import { workspaceApi } from "../src/shared/workspace-api.js";
import type {
  RouteInput,
  RouteResponse,
} from "../src/shared/route-contract.js";

const uuid = "11111111-1111-4111-8111-111111111111";

it("preserves primitive wire strings for every identity kind", () => {
  for (const schema of [
    OwnerId,
    AgentId,
    ConversationId,
    RunId,
    MessageId,
    ArtifactId,
    ApprovalId,
    TeamId,
    FolderId,
    ProjectId,
    ConnectionId,
  ]) {
    expect(schema.parse(uuid)).toBe(uuid);
    expect(JSON.stringify(schema.parse(uuid))).toBe(JSON.stringify(uuid));
    expect(schema.safeParse(123).success).toBe(false);
  }
  expect(OwnerId.parse("fixture-owner")).toBe("fixture-owner");
  expect(MessageId.parse("opaque-message-key")).toBe("opaque-message-key");
  expect(ConnectionId.parse("native-codex")).toBe("native-codex");
});
it("keeps existing request validators and unrestricted lookup IDs", () => {
  expect(
    workspaceApi.conversation.params.parse({ id: "opaque-conversation" }).id,
  ).toBe("opaque-conversation");
  expect(
    workspaceApi.session.params.safeParse({ id: "opaque-conversation" })
      .success,
  ).toBe(false);
  expect(workspaceApi.session.params.parse({ id: uuid }).id).toBe(uuid);
  expect(requestId(ConversationId).min(1).max(150).safeParse("").success).toBe(
    false,
  );
  expect(requestId(ConversationId).parse("")).toBe("");
});
it("allows raw server response builders but projects a nominal output", () => {
  const response = z.object({ id: RunId });
  const raw: z.input<typeof response> = { id: uuid };
  const projected = response.parse(raw);
  expect(projected.id).toBe(uuid);
});

// Never executed: CI typecheck checks the actual typed client's generic call
// signature as well as nominal schema output. No assertions manufacture IDs.
function clientTypeChecks(
  api: typeof import("../src/client/api.js").callRoute,
) {
  const agent = AgentId.parse(uuid);
  const connection = ConnectionId.parse("native-codex");
  void api(workspaceApi.agentDetail, { params: { id: agent } }, "fixture");
  void api(
    workspaceApi.connectionModels,
    { params: { id: connection } },
    "fixture",
  );
  // @ts-expect-error Connections cannot identify agents.
  void api(workspaceApi.agentDetail, { params: { id: connection } }, "fixture");
  // @ts-expect-error Agents cannot identify connections.
  void api(workspaceApi.connectionModels, { params: { id: agent } }, "fixture");
  const artifact = ArtifactId.parse(uuid);
  const folder = FolderId.parse(uuid);
  void api(
    workspaceApi.artifactDetail,
    { params: { id: artifact } },
    "fixture",
  );
  void api(
    workspaceApi.folderUpdate,
    { params: { id: folder }, body: { name: "Folder" } },
    "fixture",
  );
  // @ts-expect-error Folder IDs cannot identify artifacts.
  void api(workspaceApi.artifactDetail, { params: { id: folder } }, "fixture");
  void api(
    workspaceApi.folderUpdate,
    // @ts-expect-error Artifact IDs cannot identify folders.
    { params: { id: artifact }, body: { name: "Folder" } },
    "fixture",
  );
  const team = TeamId.parse(uuid);
  const approval = ApprovalId.parse(uuid);
  const message = MessageId.parse("opaque-message");
  void api(
    workspaceApi.teamDelete,
    { params: { id: team }, body: {} },
    "fixture",
  );
  void api(
    workspaceApi.approval,
    { params: { id: approval }, body: { decision: "approve" } },
    "fixture",
  );
  void api(workspaceApi.messageDetail, { params: { id: message } }, "fixture");
  // @ts-expect-error Team IDs cannot identify messages.
  const wrongMessage: RouteInput<
    typeof workspaceApi.messageDetail
  >["params"]["id"] = team;
  // @ts-expect-error Message IDs cannot identify approvals.
  const wrongApproval: RouteInput<
    typeof workspaceApi.approval
  >["params"]["id"] = message;
  // @ts-expect-error Approval IDs cannot identify teams.
  const wrongTeam: RouteInput<typeof workspaceApi.teamDelete>["params"]["id"] =
    approval;
  void [wrongMessage, wrongApproval, wrongTeam];
  const route = workspaceApi.conversation;
  const conversation = ConversationId.parse(uuid);
  const run: RouteResponse<typeof workspaceApi.runMove>["id"] =
    RunId.parse(uuid);
  void api(route, { params: { id: conversation } }, "fixture");
  void api(workspaceApi.session, { params: { id: conversation } }, "fixture");
  // @ts-expect-error UUID validation retains the nominal input requirement.
  void api(workspaceApi.session, { params: { id: uuid } }, "fixture");
  // @ts-expect-error A run identity cannot be passed as a conversation identity.
  void api(route, { params: { id: run } }, "fixture");
  // @ts-expect-error Parse raw URL/storage strings at the ingress boundary.
  void api(route, { params: { id: "raw" } }, "fixture");
  // @ts-expect-error Only a named branded schema can define a request ID view.
  requestId(z.string());
  const projectFolder: FolderId = ProjectId.parse(uuid);
  void projectFolder;
  // @ts-expect-error An arbitrary folder is not necessarily a project.
  const project: ProjectId = FolderId.parse(uuid);
  void project;
}
void clientTypeChecks;

it("projects nominal core entity IDs while allowing raw server builders", () => {
  type Bootstrap = RouteResponse<typeof workspaceApi.bootstrap>;
  type Agent = Bootstrap["agents"][number];
  type Folder = Bootstrap["folders"][number];
  type Team = Bootstrap["teams"][number];
  type Conversation = RouteResponse<
    typeof workspaceApi.conversation
  >["conversation"];
  type Message = RouteResponse<
    typeof workspaceApi.conversation
  >["messages"][number];
  type Run = RouteResponse<typeof workspaceApi.runs>[number];
  type Approval = RouteResponse<typeof workspaceApi.approvals>[number];
  type Artifact = z.output<
    typeof import("../src/shared/artifact-contract-schema.js").PublicArtifact
  >;
  expectTypeOf<Agent["id"]>().toEqualTypeOf<AgentId>();
  expectTypeOf<Agent["owner_id"]>().toEqualTypeOf<OwnerId>();
  expectTypeOf<Agent["connection_id"]>().toEqualTypeOf<ConnectionId | null>();
  expectTypeOf<
    Bootstrap["connections"][number]["id"]
  >().toEqualTypeOf<ConnectionId>();
  expectTypeOf<Folder["id"]>().toEqualTypeOf<FolderId>();
  expectTypeOf<Folder["parent_id"]>().toEqualTypeOf<FolderId | null>();
  expectTypeOf<Team["id"]>().toEqualTypeOf<TeamId>();
  expectTypeOf<Team["members"][number]>().toEqualTypeOf<AgentId>();
  expectTypeOf<Conversation["id"]>().toEqualTypeOf<ConversationId>();
  expectTypeOf<Conversation["project_id"]>().toEqualTypeOf<ProjectId | null>();
  expectTypeOf<Message["id"]>().toEqualTypeOf<MessageId>();
  expectTypeOf<Message["run_id"]>().toEqualTypeOf<RunId | null>();
  expectTypeOf<Run["agent_id"]>().toEqualTypeOf<AgentId | null>();
  expectTypeOf<Approval["id"]>().toEqualTypeOf<ApprovalId>();
  expectTypeOf<Approval["run_id"]>().toEqualTypeOf<RunId>();
  expectTypeOf<Artifact["id"]>().toEqualTypeOf<ArtifactId>();
  expectTypeOf<Artifact["folder_id"]>().toEqualTypeOf<FolderId | null>();
  type Raw = z.input<typeof workspaceApi.bootstrap.response>;
  expectTypeOf<Raw["agents"][number]["id"]>().toEqualTypeOf<string>();
});

it("preserves unrestricted agent and native connection lookup strings", () => {
  expect(workspaceApi.agentDetail.params.parse({ id: "opaque-agent" }).id).toBe(
    "opaque-agent",
  );
  expect(
    workspaceApi.connectionModels.params.parse({ id: "native-codex" }).id,
  ).toBe("native-codex");
  expect(workspaceApi.agentDetail.params.safeParse({ id: 42 }).success).toBe(
    false,
  );
});

it("preserves unrestricted artifact and folder request validators", () => {
  expect(
    workspaceApi.artifactDetail.params.parse({ id: "opaque-artifact" }).id,
  ).toBe("opaque-artifact");
  expect(
    workspaceApi.folderUpdate.params.parse({ id: "opaque-folder" }).id,
  ).toBe("opaque-folder");
  expect(workspaceApi.artifactDetail.params.safeParse({ id: 42 }).success).toBe(
    false,
  );
});

it("preserves opaque team, approval and message path strings", () => {
  for (const route of [
    workspaceApi.teamDelete,
    workspaceApi.approval,
    workspaceApi.messageDetail,
  ]) {
    expect(route.params.parse({ id: "opaque-key" }).id).toBe("opaque-key");
    expect(route.params.safeParse({ id: 42 }).success).toBe(false);
  }
});

it("parses nullable identity values without changing their wire representation", () => {
  const raw = {
    connectionId: "native-codex",
    folderId: undefined,
    parentId: null,
  };
  const input = {
    connectionId: parseId(ConnectionId, raw.connectionId),
    folderId: parseId(FolderId, raw.folderId),
    parentId: parseId(FolderId, raw.parentId),
  };
  expect(input).toEqual(raw);
  expect(JSON.stringify(input)).toBe(JSON.stringify(raw));
  expectTypeOf(parseId(AgentId, "agent")).toEqualTypeOf<AgentId>();
  expectTypeOf(parseId(FolderId, undefined)).toEqualTypeOf<
    FolderId | undefined
  >();
  type Body = RouteInput<typeof workspaceApi.agentCreate>["body"];
  // @ts-expect-error Agent creation connections cannot be identified by run IDs.
  const wrongConnection: Body["connectionId"] = RunId.parse("run");
  void wrongConnection;
});

it("keeps route-specific ID acceptance and query fallback rules", () => {
  const opaque = "native-opaque";
  expect(workspaceApi.projectOpened.params.parse({ id: opaque })).toEqual({
    id: opaque,
  });
  expect(
    workspaceApi.runtimeAuthProviders.query.safeParse({ projectId: "" })
      .success,
  ).toBe(false);
  expect(
    workspaceApi.runtimeAuthProviders.query.parse({ projectId: opaque }),
  ).toEqual({ projectId: opaque });
  expect(
    workspaceApi.nativeDecisions.query.safeParse({ conversation: opaque })
      .success,
  ).toBe(false);
  expect(workspaceApi.conversation.query.parse({ message: "" })).toEqual({
    message: "",
  });
  expect(
    workspaceApi.search.query.parse({
      q: "fixture",
      agent: ["a", "b"],
      folder: 3,
      project: opaque,
    }),
  ).toEqual({
    q: "fixture",
    agent: undefined,
    folder: undefined,
    project: opaque,
  });
  expect(workspaceApi.artifactList.query.parse({ folder: "unfiled" })).toEqual({
    folder: "unfiled",
  });
  expect(
    workspaceApi.submit.body.parse({
      agentId: "",
      conversationId: "",
      input: "fixture",
      idempotencyKey: "fixture-identity",
    }),
  ).toMatchObject({ agentId: "", conversationId: "" });
});

it("requires the core domain at actual typed route inputs", () => {
  type Opened = RouteInput<typeof workspaceApi.projectOpened>["params"];
  // @ts-expect-error An agent is not a project.
  const wrongProject: Opened = { id: AgentId.parse("agent") };
  type Submit = RouteInput<typeof workspaceApi.submit>["body"];
  // @ts-expect-error Run IDs cannot identify the target conversation.
  const wrongConversation: Submit["conversationId"] = RunId.parse("run");
  type Search = NonNullable<RouteInput<typeof workspaceApi.search>["query"]>;
  // @ts-expect-error A conversation is not an agent filter.
  const wrongFilter: Search["agent"] = ConversationId.parse("conversation");
  type Share = RouteInput<typeof workspaceApi.shareSend>["body"];
  // @ts-expect-error A folder cannot identify the shared agent.
  const wrongShare: Share["newAgentId"] = FolderId.parse("folder");
  void [wrongProject, wrongConversation, wrongFilter, wrongShare];
});

it("carries nominal domains through feature response references", () => {
  type Trace = z.output<
    typeof workspaceApi.agentTraces.response
  >["items"][number];
  expectTypeOf<Trace["run_id"]>().toEqualTypeOf<RunId>();
  expectTypeOf<
    Trace["conversation_id"]
  >().toEqualTypeOf<ConversationId | null>();
  type Saved = z.output<typeof workspaceApi.conversation.response>;
  expectTypeOf<
    Saved["position_message_id"]
  >().toEqualTypeOf<MessageId | null>();
});

it("brands route response aliases without requiring branded server inputs", () => {
  type Created = z.output<typeof workspaceApi.artifactCreate.response>;
  expectTypeOf<Created["id"]>().toEqualTypeOf<ArtifactId>();
  const raw: z.input<typeof workspaceApi.conversationContinueStart.response> = {
    id: "conversation",
    agentId: "agent",
    runId: "run",
  };
  const parsed = workspaceApi.conversationContinueStart.response.parse(raw);
  expect(parsed).toEqual(raw);
  expectTypeOf(parsed.id).toEqualTypeOf<ConversationId>();
  expectTypeOf(parsed.agentId).toEqualTypeOf<AgentId>();
  expectTypeOf(parsed.runId).toEqualTypeOf<RunId>();
});

it("retains nominal identities in Done and operational Feed projections", () => {
  type Row = z.output<typeof workspaceApi.feed.response>["items"][number];
  expectTypeOf<Row["conversation_id"]>().toEqualTypeOf<ConversationId>();
  expectTypeOf<Row["connection_id"]>().toEqualTypeOf<ConnectionId | null>();
  type Action = NonNullable<Row["next_action"]>;
  expectTypeOf<Action["run_id"]>().toEqualTypeOf<RunId>();
  expectTypeOf<Action["message_id"]>().toEqualTypeOf<MessageId | null>();
  type Page = z.output<typeof workspaceApi.conversation.response>;
  expectTypeOf<Page["saved"][number]>().toEqualTypeOf<MessageId>();
});

it("preserves string rules for each additional public record identity", () => {
  for (const schema of [
    ImportId,
    ObjectId,
    ScheduledSendId,
    PrWatchId,
    LaterItemId,
    ReviewId,
    CheckoutId,
    VerificationId,
  ]) {
    expect(schema.parse(uuid)).toBe(uuid);
    expect(schema.parse("opaque-fixture")).toBe("opaque-fixture");
    expect(schema.parse("")).toBe("");
    expect(schema.safeParse(42).success).toBe(false);
  }
  type Import = z.output<typeof workspaceApi.importList.response>[number];
  expectTypeOf<Import["id"]>().toEqualTypeOf<ImportId>();
  type Upload = z.output<typeof workspaceApi.uploadCreate.response>;
  expectTypeOf<Upload["objectId"]>().toEqualTypeOf<ObjectId>();
  expectTypeOf<Upload["id"]>().toEqualTypeOf<ArtifactId>();
  // @ts-expect-error An object is not an import job.
  const wrongImport: Import["id"] = ObjectId.parse("object");
  void wrongImport;
});

it("requires record domains at concrete typed request paths without tightening HTTP strings", () => {
  for (const route of [
    workspaceApi.objectFile,
    workspaceApi.importStart,
    workspaceApi.importCancel,
    workspaceApi.laterFinish,
    workspaceApi.laterSnooze,
    workspaceApi.laterReopen,
    workspaceApi.scheduledSendCancel,
    workspaceApi.scheduledSendUpdate,
    workspaceApi.scheduledSendRetry,
    workspaceApi.prWatchResume,
    workspaceApi.prWatchDelete,
  ]) {
    expect(route.params.parse({ id: "opaque-record" })).toEqual({
      id: "opaque-record",
    });
    expect(route.params.safeParse({ id: 42 }).success).toBe(false);
  }
  const wrongObject: RouteInput<typeof workspaceApi.objectFile>["params"] = {
    // @ts-expect-error Artifact IDs do not identify object-store rows.
    id: ArtifactId.parse("artifact"),
  };
  const wrongImport: RouteInput<typeof workspaceApi.importStart>["params"] = {
    // @ts-expect-error An object is not an import job.
    id: ObjectId.parse("object"),
  };
  const wrongLater: RouteInput<typeof workspaceApi.laterSnooze>["params"] = {
    // @ts-expect-error Scheduled sends are not Later items.
    id: ScheduledSendId.parse("scheduled"),
  };
  const wrongScheduled: RouteInput<
    typeof workspaceApi.scheduledSendCancel
  >["params"] = {
    // @ts-expect-error A PR watch is not a scheduled send.
    id: PrWatchId.parse("watch"),
  };
  void [wrongObject, wrongImport, wrongLater, wrongScheduled];
});

it("keeps stored-record domains primitive and field-specific validators unchanged", () => {
  for (const schema of [
    DefinitionId,
    DoneThreadId,
    MemorySourceId,
    McpConnectionId,
    McpCatalogEntryId,
    McpCandidateId,
    SocialStoryId,
    SocialFeedId,
    SocialWatchId,
    SocialDigestId,
    TeamPresetId,
    TeamRoleId,
  ]) {
    expect(schema.parse("opaque:fixture")).toBe("opaque:fixture");
    expect(schema.parse("")).toBe("");
    expect(schema.safeParse(42).success).toBe(false);
  }
  for (const route of [
    workspaceApi.definitionRead,
    workspaceApi.memorySource,
    workspaceApi.mcpTest,
    workspaceApi.mcpNativeImport,
    workspaceApi.mcpCatalogInstall,
    workspaceApi.socialFeedAdd,
    workspaceApi.socialWatchDelete,
    workspaceApi.socialDigestDelete,
    workspaceApi.doneThreadDetail,
  ]) {
    expect(route.params.parse({ id: "opaque:fixture" })).toEqual({
      id: "opaque:fixture",
    });
    expect(route.params.safeParse({ id: 42 }).success).toBe(false);
  }
  expect(
    workspaceApi.definitionSave.params.safeParse({ id: "opaque:fixture" })
      .success,
  ).toBe(false);
  expect(
    workspaceApi.doneThreadCreate.body.safeParse({
      id: "opaque:fixture",
      title: "Fixture",
      cardIds: ["d:run:fixture"],
    }).success,
  ).toBe(false);
  type CatalogRequest = RouteInput<
    typeof workspaceApi.mcpCatalogInstall
  >["params"];
  const wrongCatalog: CatalogRequest = {
    // @ts-expect-error A saved MCP connection is not a catalog entry.
    id: McpConnectionId.parse("connection"),
  };
  const wrongMemory: RouteInput<typeof workspaceApi.memorySource>["params"] = {
    // @ts-expect-error A message is not a memory source.
    id: MessageId.parse("message"),
  };
  expectTypeOf<
    z.output<typeof workspaceApi.socialList.response>["stories"][number]["id"]
  >().toEqualTypeOf<SocialStoryId>();
  void [wrongCatalog, wrongMemory];
});

it("distinguishes mail from thread identities without tightening string paths", () => {
  for (const schema of [MailId, MailThreadId]) {
    expect(schema.parse("opaque:mail")).toBe("opaque:mail");
    expect(schema.parse("")).toBe("");
    expect(schema.safeParse(42).success).toBe(false);
  }
  expect(
    workspaceApi.agentThreadDetail.params.parse({ id: "opaque:thread" }),
  ).toEqual({ id: "opaque:thread" });
  expect(
    workspaceApi.agentThreadDetail.params.safeParse({ id: 42 }).success,
  ).toBe(false);
  const wrong: RouteInput<typeof workspaceApi.agentThreadDetail>["params"] = {
    // @ts-expect-error A mail message is not its thread.
    id: MailId.parse("mail"),
  };
  void wrong;
});

it("preserves token and webhook validators with distinct request domains", () => {
  for (const schema of [
    CardTokenId,
    WebhookSubscriptionId,
    WebhookDeliveryId,
    WebhookRequestId,
  ]) {
    expect(schema.parse("opaque:fixture")).toBe("opaque:fixture");
    expect(schema.parse("")).toBe("");
    expect(schema.safeParse(42).success).toBe(false);
  }
  expect(
    workspaceApi.cardTokenRevoke.params.safeParse({ id: "" }).success,
  ).toBe(false);
  expect(
    workspaceApi.webhookUpdate.params.parse({ id: "opaque:fixture" }),
  ).toEqual({ id: "opaque:fixture" });
  expect(
    workspaceApi.webhookTest.body.safeParse({ request_id: "opaque:fixture" })
      .success,
  ).toBe(false);
  const wrong: RouteInput<typeof workspaceApi.webhookDeliveries>["params"] = {
    // @ts-expect-error A webhook delivery is not a subscription.
    id: WebhookDeliveryId.parse("delivery"),
  };
  void wrong;
});

it("retains record identities in embedded public summaries", () => {
  expectTypeOf<
    z.output<typeof CheckoutSummarySchema>["id"]
  >().toEqualTypeOf<CheckoutId>();
  expectTypeOf<
    z.output<typeof VerificationSummarySchema>["items"][number]["id"]
  >().toEqualTypeOf<VerificationId>();
  expectTypeOf<
    NonNullable<z.output<typeof DoneDisplaySchema>["later"]>["id"]
  >().toEqualTypeOf<LaterItemId>();
  expectTypeOf<z.output<typeof PublicTeam>["preset_id"]>().toEqualTypeOf<
    TeamPresetId | null | undefined
  >();
  expect(CheckoutSummarySchema.shape.id.parse("opaque:checkout")).toBe(
    "opaque:checkout",
  );
  expect(
    VerificationSummarySchema.shape.items.element.shape.id.parse(
      "opaque:verification",
    ),
  ).toBe("opaque:verification");
});

it("keeps native catalog, managed conversation and decision identities distinct", () => {
  for (const schema of [NativeCatalogId, NativeDecisionId]) {
    expect(schema.parse("opaque:native")).toBe("opaque:native");
    expect(schema.parse("")).toBe("");
    expect(schema.safeParse(42).success).toBe(false);
  }
  expect(
    workspaceApi.nativeHistoryDetail.params.parse({ id: "opaque:catalog" }),
  ).toEqual({ id: "opaque:catalog" });
  expect(
    workspaceApi.nativeAnswer.params.parse({ id: "opaque:decision" }),
  ).toEqual({ id: "opaque:decision" });
  type History = RouteResponse<typeof workspaceApi.nativeHistoryList>;
  expectTypeOf<
    History["managed"][number]["id"]
  >().toEqualTypeOf<ConversationId>();
  expectTypeOf<
    History["external"][number]["id"]
  >().toEqualTypeOf<NativeCatalogId>();
  const wrong: RouteInput<typeof workspaceApi.nativeHistoryFork>["params"] = {
    // @ts-expect-error A conversation is not an external catalog entry.
    id: ConversationId.parse("conversation"),
  };
  void wrong;
});

it("keeps MCP and webhook reference domains and existing field bounds", () => {
  expectTypeOf<z.output<typeof WebhookStop>["run_id"]>().toEqualTypeOf<RunId>();
  expectTypeOf<
    z.output<typeof chartSchema>["source"]["connectionId"]
  >().toEqualTypeOf<McpConnectionId>();
  expectTypeOf<
    RouteResponse<typeof workspaceApi.agentTools>[number]["connection_id"]
  >().toEqualTypeOf<McpConnectionId>();
  expect(WebhookStop.shape.run_id.safeParse("").success).toBe(false);
  expect(WebhookStop.shape.run_id.safeParse("r".repeat(301)).success).toBe(
    false,
  );
  expect(WebhookStop.shape.run_id.parse("opaque:run")).toBe("opaque:run");
  expect(
    artifactRefreshSource("agent", {
      connectionId: "mcp",
      tool: "read",
      arguments: {},
    }),
  ).toEqual({
    agentId: "agent",
    connectionId: "mcp",
    tool: "read",
    arguments: {},
  });
  expect(
    artifactRefreshSource("agent", {
      connectionId: "",
      tool: "read",
      arguments: {},
    }),
  ).toBeNull();
});

it("distinguishes native auth identities without tightening their field rules", () => {
  for (const schema of [
    NativeProviderId,
    AuthMethodId,
    AuthAttemptId,
    AuthPromptId,
    AuthOptionId,
  ]) {
    expect(schema.parse("external:opaque")).toBe("external:opaque");
    expect(schema.parse("")).toBe("");
    expect(schema.safeParse(42).success).toBe(false);
  }
  const base = {
    attemptId: uuid,
    promptId: uuid,
    value: "fixture",
  };
  expect(
    workspaceApi.runtimeAuthInput.body.parse({
      attemptId: uuid,
      promptId: uuid,
      value: "fixture",
    }),
  ).toEqual({ attemptId: uuid, promptId: uuid, value: "fixture" });
  expect(
    workspaceApi.runtimeAuthInput.body.safeParse({
      ...base,
      attemptId: "opaque",
    }).success,
  ).toBe(false);
  const wrong: RouteInput<typeof workspaceApi.runtimeAuthInput>["body"] = {
    // @ts-expect-error A prompt is not its sign-in attempt.
    attemptId: AuthPromptId.parse(uuid),
    promptId: AuthPromptId.parse(uuid),
    value: "fixture",
  };
  void wrong;
});

it("keeps execution command receipts distinct and preserves automatic IDs", () => {
  expect(ExecutionCommandId.parse("auto:" + uuid)).toBe("auto:" + uuid);
  expect(ExecutionCommandId.parse("")).toBe("");
  expect(ExecutionCommandId.safeParse(42).success).toBe(false);
  expect(workspaceApi.nativeAnswer.body.shape.commandId.parse(uuid)).toBe(uuid);
  expect(
    workspaceApi.nativeAnswer.body.shape.commandId.safeParse("auto:" + uuid)
      .success,
  ).toBe(false);
  const wrong: RouteInput<typeof workspaceApi.nativeAnswer>["body"] = {
    // @ts-expect-error An authentication attempt is not an execution command.
    commandId: AuthAttemptId.parse(uuid),
    answer: {},
  };
  void wrong;
});

it("keeps model tokens distinct while retaining existing selection limits", () => {
  for (const token of [
    "native-default",
    "provider/model:variant",
    "Imported history",
    "",
  ]) {
    expect(
      PublicModel.parse({
        id: token,
        name: "Display label",
        resolvedModel: token,
      }),
    ).toEqual({ id: token, name: "Display label", resolvedModel: token });
  }
  const create = {
    name: "fixture-agent",
    connectionId: "native-codex",
    model: "native-default",
  };
  expect(AgentCreateInput.parse(create).model).toBe("native-default");
  expect(AgentCreateInput.safeParse({ ...create, model: "" }).success).toBe(
    false,
  );
  expect(
    AgentCreateInput.safeParse({ ...create, model: "x".repeat(151) }).success,
  ).toBe(false);
  expect(AgentUpdateInput.parse({ model: null })).toEqual({ model: null });
  expect(AgentUpdateInput.safeParse({ model: "x".repeat(200) }).success).toBe(
    true,
  );
  expect(AgentUpdateInput.safeParse({ model: "x".repeat(201) }).success).toBe(
    false,
  );
  expect(ModelId.safeParse(42).success).toBe(false);
  type Create = RouteInput<typeof workspaceApi.agentCreate>["body"];
  const model: Create["model"] = ModelId.parse("native-default");
  // @ts-expect-error A connection does not identify a model.
  const wrong: Create["model"] = ConnectionId.parse("native-codex");
  // @ts-expect-error A raw catalog token must be parsed at client ingress.
  const raw: Create["model"] = "native-default";
  void [model, wrong, raw];
});

it("separates native sessions and execution correlations without tightening tokens", () => {
  for (const schema of [
    SteeringId,
    WorkerId,
    NativeGenerationId,
    NativeRequestId,
    NativeItemId,
    SessionSettingId,
    ExecutionGenerationId,
    ExecutionRequestId,
  ]) {
    expect(schema.parse("opaque:provider-token")).toBe("opaque:provider-token");
    expect(schema.parse("")).toBe("");
    expect(schema.safeParse(42).success).toBe(false);
  }
  expect(
    workspaceApi.setting.params.parse({ id: uuid, setting: "custom:key" })
      .setting,
  ).toBe("custom:key");
  const setting = {
    value: "fixture",
    revision: 0,
    generation: "opaque-session",
  };
  expect(workspaceApi.setting.body.parse(setting)).toEqual(setting);
  expect(
    workspaceApi.setting.body.safeParse({ ...setting, generation: "" }).success,
  ).toBe(false);
  expect(
    workspaceApi.setting.body.safeParse({
      ...setting,
      generation: "g".repeat(201),
    }).success,
  ).toBe(false);
  expect(
    ExecutionReady.parse({ v: 1, generation: uuid, state: "ready" }).generation,
  ).toBe(uuid);
  expect(
    ExecutionReady.safeParse({ v: 1, generation: "opaque", state: "ready" })
      .success,
  ).toBe(false);
  expect(ExecutionRequest.shape.requestId.safeParse("opaque").success).toBe(
    false,
  );
  const wrongSetting: RouteInput<typeof workspaceApi.setting>["body"] = {
    value: "fixture",
    revision: 0,
    // @ts-expect-error An execution worker generation is not a native session generation.
    generation: ExecutionGenerationId.parse(uuid),
  };
  // @ts-expect-error A request correlation is not an execution generation.
  const wrongReady: z.output<typeof ExecutionReady>["generation"] =
    ExecutionRequestId.parse(uuid);
  // @ts-expect-error A native request is not a displayed native item.
  const wrongItem: NativeItemId = NativeRequestId.parse("opaque");
  // @ts-expect-error A steering receipt is not a worker lease identity.
  const wrongWorker: WorkerId = SteeringId.parse(uuid);
  // @ts-expect-error A model token is not a setting key.
  const wrongKey: RouteInput<typeof workspaceApi.setting>["params"]["setting"] =
    ModelId.parse("default");
  void [wrongSetting, wrongReady, wrongItem, wrongWorker, wrongKey];
});

it("keeps activity identities separate and preserves ingest bounds and upload receipts", () => {
  for (const schema of [
    ActivityId,
    ActivityKey,
    PlanStepId,
    CatalogCommandId,
    ToolCallId,
    TerminalId,
    TraceKey,
    OperationId,
  ]) {
    expect(schema.parse("opaque:provider-token")).toBe("opaque:provider-token");
    expect(schema.parse("")).toBe("");
    expect(schema.safeParse(42).success).toBe(false);
  }
  const output = {
    v: 1,
    kind: "output",
    id: "tool:output",
    source: { transport: "acp", origin: "fixture" },
    patch: { tool: "tool", terminal: "acp-terminal:opaque" },
  };
  expect(ActivityUpdate.parse(output)).toEqual(output);
  expect(ActivityUpdate.safeParse({ ...output, id: "" }).success).toBe(false);
  expect(
    ActivityUpdate.safeParse({ ...output, id: "x".repeat(301) }).success,
  ).toBe(false);
  const plan = {
    ...output,
    kind: "plan",
    patch: { steps: [{ id: "step-0", title: "Fixture", status: "pending" }] },
  };
  expect(ActivityUpdate.parse(plan)).toEqual(plan);
  expect(TraceId.parse(17)).toBe(17);
  expect(TraceId.safeParse("17").success).toBe(false);
  expect(
    workspaceApi.operationUndo.params.parse({ id: "opaque-operation" }).id,
  ).toBe("opaque-operation");
  expect(workspaceApi.operationUndo.params.safeParse({ id: 42 }).success).toBe(
    false,
  );
  expect(AttachmentIds.parse([uuid, uuid])).toEqual([uuid]);
  expect(AttachmentIds.parse(undefined)).toEqual([]);
  expect(AttachmentIds.safeParse(["opaque-artifact"]).success).toBe(false);
  type Activity = RouteResponse<
    typeof workspaceApi.conversationActivities
  >["items"][number];
  // @ts-expect-error An activity record ID is not the composite projection key.
  const wrongKey: Activity["key"] = ActivityId.parse("tool");
  type Commands = Extract<Activity["record"], { kind: "commands" }>;
  // @ts-expect-error A setting key does not identify a catalog command.
  const wrongCommand: Commands["data"]["commands"][number]["id"] =
    SessionSettingId.parse("model");
  type Plan = Extract<Activity["record"], { kind: "plan" }>;
  // @ts-expect-error A catalog command does not identify a plan step.
  const wrongStep: Plan["data"]["steps"][number]["id"] =
    CatalogCommandId.parse("command");
  // @ts-expect-error A raw row number must be projected through the trace schema.
  const wrongRow: TraceId = 17;
  // @ts-expect-error A run is not a filing operation.
  const wrongOperation: RouteInput<
    typeof workspaceApi.operationUndo
  >["params"]["id"] = RunId.parse(uuid);
  const wrongAttachments: NonNullable<
    RouteInput<typeof workspaceApi.agentCreate>["body"]["attachmentIds"]
  > = [
    // @ts-expect-error Uploaded attachments are artifacts, not object-storage IDs.
    ObjectId.parse(uuid),
  ];
  void [
    wrongKey,
    wrongCommand,
    wrongStep,
    wrongRow,
    wrongOperation,
    wrongAttachments,
  ];
});

it("projects shell and event owners with the canonical label bounds", () => {
  const session = {
    user: { id: "local-workspace", name: "Your workspace" },
    mode: "paired",
  };
  expect(workspaceApi.authSession.response.parse(session)).toEqual(session);
  expect(
    workspaceApi.authSession.response.safeParse({
      ...session,
      user: { id: "", name: "Fixture" },
    }).success,
  ).toBe(false);
  expect(
    workspaceApi.authSession.response.safeParse({
      ...session,
      user: { id: "x".repeat(201), name: "Fixture" },
    }).success,
  ).toBe(false);
});

it("retains remaining identity formats and separates their nominal domains", () => {
  for (const schema of [
    Remaining.PairedDeviceId,
    Remaining.AgentSourceId,
    Remaining.WorkspaceSubscriptionId,
    Remaining.WorkspaceEpochId,
    Remaining.ViewportSessionId,
    Remaining.BuildId,
    Remaining.ProcessInstanceId,
    Remaining.PreviewBuildId,
    Remaining.GitCommitId,
    Remaining.GitHubThreadId,
    Remaining.EventSubjectId,
    Remaining.FeedProjectionId,
    Remaining.PersonalDecisionId,
    Remaining.SearchDocumentId,
    Remaining.MemoryOriginId,
    Remaining.AgentAddressId,
    Remaining.ExternalConversationId,
    Remaining.MessageUpdateKey,
    Remaining.IdempotencyKey,
  ]) {
    expect(schema.parse("opaque:source/value")).toBe("opaque:source/value");
    expect(schema.parse("")).toBe("");
    expect(schema.safeParse(42).success).toBe(false);
  }
  expect(Remaining.AgentAddressId.parse(`peer:machine:${uuid}`)).toBe(
    `peer:machine:${uuid}`,
  );
  expect(Remaining.PersonalDecisionId.parse(`approval:${uuid}`)).toBe(
    `approval:${uuid}`,
  );
  expect(Remaining.PersonalDecisionId.parse(`native:${uuid}`)).toBe(
    `native:${uuid}`,
  );
  expect(Remaining.FeedProjectionId.parse(JSON.stringify([uuid, null]))).toBe(
    JSON.stringify([uuid, null]),
  );
  for (const schema of [Remaining.EventId, Remaining.GitHubPullNumber]) {
    expect(schema.parse(17)).toBe(17);
    expect(schema.safeParse("17").success).toBe(false);
  }
  expectTypeOf<
    import("../src/client/agentSources").AgentSource["id"]
  >().toEqualTypeOf<Remaining.AgentSourceId>();
  expectTypeOf<
    RouteResponse<typeof workspaceApi.build>["processes"][number]["instance"]
  >().toEqualTypeOf<Remaining.ProcessInstanceId>();
  expectTypeOf<
    keyof NonNullable<
      RouteInput<typeof workspaceApi.teamFromPreset>["body"]["roles"]
    >
  >().toEqualTypeOf<TeamRoleId>();
  type Revoke = RouteInput<typeof workspaceApi.workspaceRevoke>["body"];
  // @ts-expect-error Process identities cannot revoke a paired device.
  const wrongDevice: Revoke = { id: Remaining.ProcessInstanceId.parse(uuid) };
  // @ts-expect-error GitHub pull numbers and event row IDs are different domains.
  const wrongNumber: RouteInput<
    typeof workspaceApi.prWatchCreate
  >["body"]["number"] = Remaining.EventId.parse(1);
  // @ts-expect-error A personal decision path is not the raw approval record ID.
  const wrongDecision: RouteInput<
    typeof workspaceApi.personalApproval
  >["params"]["id"] = ApprovalId.parse(uuid);
  // @ts-expect-error Object storage IDs are not valid reminder targets.
  const wrongTarget: RouteInput<
    typeof workspaceApi.laterCreate
  >["body"]["targetId"] = ObjectId.parse(uuid);
  // @ts-expect-error An execution command identity is not a generic receipt key.
  const wrongReceipt: RouteInput<
    typeof workspaceApi.submit
  >["body"]["idempotencyKey"] = ExecutionCommandId.parse(uuid);
  // @ts-expect-error Preview manifests and compiled builds have separate identities.
  const wrongBuild: Remaining.BuildId = Remaining.PreviewBuildId.parse(uuid);
  // @ts-expect-error A source identity is not a multiplex subscription identity.
  const wrongSubscription: Remaining.WorkspaceSubscriptionId =
    Remaining.AgentSourceId.parse("docker:fixture");
  void [
    wrongDevice,
    wrongNumber,
    wrongDecision,
    wrongTarget,
    wrongReceipt,
    wrongBuild,
    wrongSubscription,
  ];
});

it("keeps coercion and bounds at the request boundary", () => {
  expect(
    workspaceApi.viewportDiagnostics.body.shape.session.safeParse("bad")
      .success,
  ).toBe(false);
  expect(workspaceApi.viewportDiagnostics.body.shape.session.parse(uuid)).toBe(
    uuid,
  );
  const revoke = workspaceApi.workspaceRevoke.body;
  for (const id of [42, null, undefined, "", uuid])
    expect(revoke.parse({ id }).id).toBe(String(id));
  const pull = workspaceApi.githubPullDetail.params;
  for (const number of [64, "064", "6.4e1"])
    expect(pull.parse({ owner: "acme", repo: "api", number }).number).toBe(64);
  expect(Remaining.parsePullNumber("064")).toBe(64);
  expect(Remaining.parsePullNumber(64)).toBe(64);
  for (const number of [0, -1, 1.5, 1e9, "nope"])
    expect(pull.safeParse({ owner: "acme", repo: "api", number }).success).toBe(
      false,
    );
  const later = {
    kind: "message",
    condition: "time",
    dueAt: Date.now() + 60000,
  };
  expect(
    workspaceApi.laterCreate.body.parse({ ...later, targetId: "opaque" })
      .targetId,
  ).toBe("opaque");
  for (const value of ["", "x".repeat(151), 42]) {
    expect(Remaining.LaterTargetInput.safeParse(value).error?.issues).toEqual(
      z.string().min(1).max(150).safeParse(value).error?.issues,
    );
    expect(Remaining.WebhookDecisionId.safeParse(value).error?.issues).toEqual(
      z.string().min(1).max(300).safeParse(value).error?.issues,
    );
    expect(Remaining.ResultEntityId.safeParse(value).error?.issues).toEqual(
      z.string().safeParse(value).error?.issues,
    );
  }
  for (const targetId of ["", "x".repeat(151), 42])
    expect(
      workspaceApi.laterCreate.body.safeParse({ ...later, targetId }).success,
    ).toBe(false);
  const sha = "A".repeat(40);
  expect(workspaceApi.githubPullFiles.query.parse({ head: sha }).head).toBe(
    sha,
  );
  expect(
    workspaceApi.githubPullFiles.query.safeParse({ head: "bad" }).success,
  ).toBe(false);
  expect(
    Multiplex.WorkspaceMuxRequest.safeParse({
      v: 1,
      type: "unsubscribe",
      id: "bad",
    }).success,
  ).toBe(false);
  const request = {
    v: 1,
    type: "subscribe",
    conversations: [],
    runs: [],
    id: uuid,
    source: "",
    epoch: "",
    cursor: 0,
  };
  expect(Multiplex.WorkspaceMuxRequest.safeParse(request).success).toBe(true);
  expect(
    Multiplex.WorkspaceMuxRequest.safeParse({
      ...request,
      source: "bad source",
    }).success,
  ).toBe(false);
  expect(
    Multiplex.WorkspaceMuxRequest.safeParse({
      ...request,
      epoch: "x".repeat(201),
    }).success,
  ).toBe(false);
});
