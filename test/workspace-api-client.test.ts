import { IdempotencyKey } from "../src/shared/contract-ids.js";
import { ArtifactId } from "../src/shared/contract-ids.js";
import { ModelId } from "../src/shared/contract-ids.js";
import { ExecutionCommandId } from "../src/shared/contract-ids.js";
import { NativeDecisionId } from "../src/shared/contract-ids.js";
import {
  ConnectionId,
  FolderId,
  parseId,
  ConversationId,
  AgentId,
  MessageId,
} from "../src/shared/contract-ids.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { workspaceApi } from "../src/shared/workspace-api";
import {
  callRoute,
  readRoute,
  routePath,
  UnavailableResponse,
} from "../src/client/api";
import { setViewOwner } from "../src/client/viewCache";
import { planSend, settleFailure } from "../src/client/sendIntent";
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.useFakeTimers();
  setViewOwner(undefined);
  setViewOwner("route-owner");
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const answer = {
  params: { id: NativeDecisionId.parse("decision/id") },
  body: {
    commandId: ExecutionCommandId.parse("f7719a2b-dea1-4c80-8c5f-de7c503cab12"),
    answer: { choice: "allow" },
  },
};

it("encodes route identities and keeps input query values instead of serializing coercion defaults", async () => {
  expect(
    routePath(workspaceApi.conversation, {
      params: { id: ConversationId.parse("thread/id") },
      query: { message: MessageId.parse("a&b") },
    }),
  ).toBe("/conversations/thread%2Fid?message=a%26b");
  expect(routePath(workspaceApi.results, {})).toBe("/results");
  fetcher.mockResolvedValueOnce(
    new Response('{"state":"resolved","private":"discard"}'),
  );
  const controller = new AbortController();
  await expect(
    callRoute(
      workspaceApi.nativeAnswer,
      answer,
      "docker:one",
      controller.signal,
    ),
  ).resolves.toEqual({ state: "resolved" });
  expect(fetcher.mock.calls[0][0]).toBe(
    "/api/agent-sources/docker%3Aone/native/decisions/decision%2Fid",
  );
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    method: "POST",
    signal: controller.signal,
    body: JSON.stringify(answer.body),
  });
});

it("keeps malformed inputs off the network and never retries an uncertain mutation or malformed acknowledgement", async () => {
  await expect(
    callRoute(
      workspaceApi.nativeAnswer,
      {
        ...answer,
        body: { ...answer.body, commandId: ExecutionCommandId.parse("bad") },
      },
      "",
    ),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(
    new Response('{"error":"Inspect first","executionOutcome":"unknown"}', {
      status: 503,
    }),
  );
  await expect(
    callRoute(workspaceApi.nativeAnswer, answer, ""),
  ).rejects.toMatchObject({ status: 503, executionOutcome: "unknown" });
  fetcher.mockResolvedValueOnce(new Response('{"state":42}'));
  await expect(
    callRoute(workspaceApi.nativeAnswer, answer, ""),
  ).rejects.toBeInstanceOf(UnavailableResponse);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("preserves source-bound request filters without URLSearchParams.size", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    URLSearchParams.prototype,
    "size",
  );
  Reflect.deleteProperty(URLSearchParams.prototype, "size");
  try {
    expect("size" in new URLSearchParams()).toBe(false);
    fetcher.mockImplementation(async () => Response.json([]));
    await callRoute(
      workspaceApi.runs,
      { query: { active: "1", teams: "team one,team/two" } },
      "docker:one",
    );
    expect(fetcher.mock.calls[0][0]).toBe(
      "/api/agent-sources/docker%3Aone/runs?active=1&teams=team+one%2Cteam%2Ftwo",
    );
    const conversation = "f7719a2b-dea1-4c80-8c5f-de7c503cab12";
    await readRoute(
      workspaceApi.nativeDecisions,
      { query: { conversation: ConversationId.parse(conversation) } },
      "",
      new AbortController().signal,
    );
    expect(fetcher.mock.calls[1][0]).toBe(
      "/api/native/decisions?conversation=" + conversation,
    );
    await callRoute(workspaceApi.runs, {}, "");
    expect(fetcher.mock.calls[2][0]).toBe("/api/runs");
  } finally {
    if (descriptor)
      Object.defineProperty(URLSearchParams.prototype, "size", descriptor);
  }
});

it("reads current source catalogs and refuses missing or malformed metadata", async () => {
  const catalog = {
    agents: [],
    connections: [],
    folders: [],
    teams: [],
    environmentName: "Source",
  };
  fetcher.mockResolvedValueOnce(Response.json(catalog));
  await expect(
    callRoute(workspaceApi.bootstrap, {}, "docker:source"),
  ).resolves.toEqual(catalog);
  fetcher.mockResolvedValueOnce(
    Response.json({ ...catalog, teams: undefined }),
  );
  await expect(
    callRoute(workspaceApi.bootstrap, {}, "docker:source"),
  ).rejects.toBeInstanceOf(UnavailableResponse);
  fetcher.mockResolvedValueOnce(Response.json({ ...catalog, teams: null }));
  await expect(
    callRoute(workspaceApi.bootstrap, {}, "docker:source"),
  ).rejects.toBeInstanceOf(UnavailableResponse);
});

it("settles local input failures as readable refusals while malformed acknowledgements remain uncertain", async () => {
  const planned = planSend(
    { signature: "", key: "", unquoted: false },
    "draft",
    { mode: "send", sendAt: null },
    () => "request-key",
  );
  const error = await callRoute(
    workspaceApi.submit,
    {
      body: {
        agentId: AgentId.parse("agent"),
        input: "Draft",
        replyExcerpt: "Excerpt without its message",
        idempotencyKey: IdempotencyKey.parse(planned.receipt.key),
      },
    },
    "",
  ).catch((error: Error & { status?: number }) => error);
  expect(error).toMatchObject({
    status: 400,
    message: "Choose the message the excerpt comes from",
  });
  expect(fetcher).not.toHaveBeenCalled();
  if (!(error instanceof Error)) throw new Error("Expected local refusal");
  const refused = settleFailure(
    planned.receipt,
    (error as Error & { status?: number }).status,
  );
  expect(refused.pending).toBe(false);
  expect(
    planSend(refused, "draft", { mode: "queue", sendAt: null }, () => "unused"),
  ).toMatchObject({ intent: { mode: "queue" }, reconciled: false });
  fetcher.mockResolvedValueOnce(Response.json({ state: 42 }));
  const unknown = await callRoute(workspaceApi.nativeAnswer, answer, "").catch(
    (error) => error,
  );
  expect(unknown).toBeInstanceOf(UnavailableResponse);
  expect(unknown.status).toBeUndefined();
  expect(settleFailure(planned.receipt, unknown.status).pending).toBe(true);
});

it("retains bounded read recovery and aborts the originating view while waiting", async () => {
  fetcher
    .mockResolvedValueOnce(new Response('{"error":"Busy"}', { status: 503 }))
    .mockResolvedValueOnce(new Response("[]"));
  const controller = new AbortController();
  const pending = readRoute(
    workspaceApi.runs,
    { query: { active: "1" } },
    "docker:one",
    controller.signal,
  );
  await vi.advanceTimersByTimeAsync(2000);
  await expect(pending).resolves.toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValueOnce(
    new Response('{"error":"Busy"}', { status: 503 }),
  );
  const cancelled = readRoute(
    workspaceApi.runs,
    {},
    "docker:one",
    controller.signal,
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  expect((await cancelled).name).toBe("AbortError");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("keeps request defaults off the wire after ID ingress parsing", async () => {
  const raw = {
    name: "fixture-agent",
    connectionId: "native-codex",
    model: "default",
  };
  const body = {
    ...raw,
    model: ModelId.parse(raw.model),
    connectionId: parseId(ConnectionId, raw.connectionId),
    folderId: parseId(FolderId, undefined),
  };
  fetcher.mockResolvedValueOnce(
    Response.json({
      id: "agent",
      owner_id: "owner",
      name: raw.name,
      provider: "codex",
      connection_id: raw.connectionId,
      model: raw.model,
      instructions: "",
      origin: "loop",
      created_at: 0,
    }),
  );
  await callRoute(workspaceApi.agentCreate, { body }, "");
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(raw);
});

it("preserves attachment order and duplicates on the request wire", async () => {
  const attachment = "11111111-1111-4111-8111-111111111111";
  const raw = {
    name: "fixture-agent",
    connectionId: "native-codex",
    model: "default",
    attachmentIds: [attachment, attachment],
  };
  fetcher.mockResolvedValueOnce(
    Response.json({
      id: "agent",
      owner_id: "owner",
      name: raw.name,
      provider: "codex",
      connection_id: raw.connectionId,
      model: raw.model,
      instructions: "",
      origin: "loop",
      created_at: 0,
    }),
  );
  await callRoute(
    workspaceApi.agentCreate,
    {
      body: {
        ...raw,
        connectionId: ConnectionId.parse(raw.connectionId),
        model: ModelId.parse(raw.model),
        attachmentIds: raw.attachmentIds.map((id) => ArtifactId.parse(id)),
      },
    },
    "",
  );
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(raw);
});
