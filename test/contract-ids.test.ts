import { expect, it } from "vitest";
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
  const route = workspaceApi.conversation;
  const conversation = ConversationId.parse(uuid);
  const run: RouteResponse<typeof workspaceApi.runMove>["id"] =
    RunId.parse(uuid);
  void api(route, { params: { id: conversation } }, "fixture");
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
