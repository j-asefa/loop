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
