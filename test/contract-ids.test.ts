import { expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
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
} from "../src/shared/contract-ids.js";
import { workspaceApi } from "../src/shared/workspace-api.js";
import type { RouteResponse } from "../src/shared/route-contract.js";

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
  const folder: FolderId = ProjectId.parse(uuid);
  void folder;
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
