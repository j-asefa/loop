import { ConversationId, RunId, requestId } from "./contract-ids.js";
import { z } from "zod";
import * as memory from "./memory-contract-schemas.js";
import { Text, Id, Ok, endpoint, base } from "./route-contract.js";

export const memoryRoutes = {
  conversationMemory: endpoint({
    ...base,
    operation: "conversationMemory",
    method: "GET",
    path: "/conversations/:id/memory",
    params: z.object({ id: requestId(ConversationId) }),
    response: z.object({ memoryIncluded: z.boolean() }),
  }),
  memoryStatus: endpoint({
    ...base,
    operation: "memoryStatus",
    method: "GET",
    path: "/memory",
    response: memory.PublicMemoryStatus,
  }),
  memoryPolicy: endpoint({
    ...base,
    operation: "memoryPolicy",
    method: "PUT",
    path: "/memory/policy",
    body: memory.MemoryPolicyInput,
    response: Ok,
  }),
  memorySource: endpoint({
    ...base,
    operation: "memorySource",
    method: "GET",
    path: "/memory/sources/:id",
    params: Id,
    response: memory.PublicMemorySource,
  }),
  memorySourceDelete: endpoint({
    ...base,
    operation: "memorySourceDelete",
    method: "DELETE",
    path: "/memory/sources/:id",
    params: Id,
    body: z.unknown(),
    response: Ok.extend({ originalHistoryRetained: z.literal(true) }),
  }),
  memoryNoteCreate: endpoint({
    ...base,
    operation: "memoryNoteCreate",
    method: "POST",
    path: "/memory/notes",
    body: memory.MemoryNoteInput,
    response: z.object({ id: Text }),
  }),
  memoryNoteUpdate: endpoint({
    ...base,
    operation: "memoryNoteUpdate",
    method: "PATCH",
    path: "/memory/notes/:id",
    params: Id,
    body: memory.MemoryNoteUpdateInput,
    response: Ok,
  }),
  memoryNoteVersions: endpoint({
    ...base,
    operation: "memoryNoteVersions",
    method: "GET",
    path: "/memory/notes/:id/versions",
    params: Id,
    response: memory.PublicMemoryVersions,
  }),
  runMemory: endpoint({
    ...base,
    operation: "runMemory",
    method: "GET",
    path: "/runs/:id/memory",
    params: z.object({ id: requestId(RunId) }),
    response: memory.PublicMemoryReceipt,
  }),
} as const;
