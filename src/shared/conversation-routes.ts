import { ConversationPulls } from "./conversation-pulls.js";
import { z } from "zod";
import { SessionControls } from "./session-controls.js";
import { AttachmentIds } from "./uploads.js";
import { REPLY_EXCERPT_LIMIT } from "./replies.js";
import { Text, Id, Ok, endpoint, base } from "./route-contract.js";
import {
  PublicRun,
  ConversationPage,
  Approval,
  NativeDecision,
  Teams,
} from "./workspace-contract-schemas.js";

export const conversationRoutes = {
  conversation: endpoint({
    ...base,
    operation: "conversation",
    access: { admits: ["read"] },
    method: "GET",
    path: "/conversations/:id",
    params: Id,
    query: z.object({
      before: Text.max(512).optional(),
      message: Text.max(150).optional(),
      resume: z.enum(["0", "1"]).optional(),
    }),
    response: ConversationPage,
  }),
  conversationPulls: endpoint({
    ...base,
    operation: "conversationPulls",
    method: "GET",
    path: "/conversations/:id/pulls",
    params: Id,
    query: z.object({ refresh: z.enum(["1"]).optional() }),
    response: ConversationPulls,
  }),
  runs: endpoint({
    ...base,
    operation: "runs",
    access: { admits: ["read"] },
    method: "GET",
    path: "/runs",
    query: z.object({ teams: Teams, active: Text.optional() }),
    response: z.array(PublicRun),
  }),
  submit: endpoint({
    ...base,
    operation: "submit",
    access: { admits: ["write"] },
    identity: "idempotencyKey",
    method: "POST",
    path: "/runs",
    body: z
      .object({
        agentId: Text,
        conversationId: Text.optional(),
        replyToMessageId: Text.min(1).max(150).optional(),
        replyExcerpt: Text.trim().min(1).max(REPLY_EXCERPT_LIMIT).optional(),
        input: Text.trim().min(1).max(30000),
        attachmentIds: AttachmentIds,
        idempotencyKey: Text.min(8).max(150),
        folderId: Text.min(1).nullable().optional(),
        queue: z.boolean().optional(),
      })
      .refine((d) => !d.replyExcerpt || d.replyToMessageId, {
        message: "Choose the message the excerpt comes from",
        path: ["replyExcerpt"],
      }),
    response: PublicRun,
    status: 202,
  }),
  runAction: endpoint({
    ...base,
    operation: "runAction",
    access: { admits: ["write"] },
    identity: "idempotencyKey",
    method: "POST",
    path: "/runs/:id/:action",
    params: Id.extend({ action: Text }),
    body: z
      .object({ idempotencyKey: Text.min(8).max(150).optional() })
      .optional(),
    response: z.union([PublicRun, Ok]),
  }),
  approvals: endpoint({
    ...base,
    operation: "approvals",
    access: { admits: ["read"] },
    method: "GET",
    path: "/approvals",
    query: z.object({ teams: Teams }),
    response: z.array(Approval),
  }),
  approval: endpoint({
    ...base,
    operation: "approval",
    access: { admits: ["approvals:decide"] },
    identity: "idempotencyKey",
    method: "POST",
    path: "/approvals/:id",
    params: Id,
    body: z.object({
      decision: z.enum(["approve", "reject"]),
      idempotencyKey: Text.min(8).max(150).optional(),
    }),
    response: Ok,
  }),
  nativeDecisions: endpoint({
    ...base,
    operation: "nativeDecisions",
    access: { admits: ["read"] },
    method: "GET",
    path: "/native/decisions",
    query: z.object({ conversation: Text.uuid().optional() }),
    response: z.array(NativeDecision),
  }),
  nativeAnswer: endpoint({
    ...base,
    operation: "nativeAnswer",
    access: { admits: ["approvals:decide"] },
    identity: "commandId",
    method: "POST",
    path: "/native/decisions/:id",
    params: Id,
    body: z.strictObject({
      commandId: Text.uuid(),
      answer: z.record(Text, z.json()),
    }),
    response: z.object({ state: Text }),
  }),
  session: endpoint({
    ...base,
    operation: "session",
    method: "GET",
    path: "/conversations/:id/settings",
    params: z.object({ id: Text.uuid() }),
    response: SessionControls,
  }),
  setting: endpoint({
    ...base,
    operation: "setting",
    method: "PATCH",
    path: "/conversations/:id/settings/:setting",
    params: z.object({ id: Text.uuid(), setting: Text }),
    body: z.strictObject({
      value: z.union([Text.max(1000), z.boolean(), z.number()]),
      revision: z.number().int().nonnegative(),
      generation: Text.min(1).max(200),
      commandId: Text.uuid().optional(),
    }),
    response: SessionControls,
  }),
} as const;
