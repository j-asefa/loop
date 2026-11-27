import type { AgentModelSelection } from "../models";
import {
  parseArtifactFileMetadata,
  parseContentDispositionFilename,
  type PublishedFileItem,
} from "./files";
import { assertSameOriginResponse } from "./pairing-url";
import type {
  ApiAgent,
  ApiApproval,
  ApiArtifactDetail,
  ApiBootstrap,
  ApiConversationPage,
  ApiDoneCardPage,
  ApiFeedItem,
  ApiFeedPage,
  ApiLaterItem,
  ApiMessage,
  ApiNativeDecision,
  ApiPersonalFile,
  ApiPersonalProfile,
  ApiPersonalPrompt,
  ApiProjectSummary,
  ApiPullItem,
  ApiRunFile,
  ApiSavedEntry,
  ApiScheduledSend,
  ApiSearchResponse,
  ApiSharePreview,
  ApiSnippet,
  ApiSocialStory,
  PairedSession,
} from "./types";

export class LoopApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Returns true when an error leaves the server-side effect uncertain
 * (client timeout, gateway timeout/5xx, or network disconnect) so callers
 * preserve state and re-read instead of rolling back or replaying under a new key.
 */
export function isUncertainOutcomeError(err: unknown): boolean {
  if (err instanceof LoopApiError) {
    return err.status === 408 || err.status >= 500;
  }
  if (err instanceof Error) {
    return err.name === "AbortError" || err.name === "TypeError";
  }
  return false;
}

export type UploadedAttachment = {
  id: string;
  objectId: string;
  name: string;
  mime: string;
  size: number;
};

export function randomUuid(): string {
  // RFC4122 v4 UUID using Web Crypto when available, safe fallback otherwise.
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const RUN_REQUEST_TIMEOUT_MS = 25_000;
const UPLOAD_TIMEOUT_MS = 60_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (typeof AbortController === "undefined") {
    return fetch(url, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new LoopApiError(
        408,
        "Request timed out — check your connection and try again.",
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Typed HTTP client talking directly to a paired Loop companion server over
 * Loop's native cookie + Origin + X-Loop-CSRF protocol (zero server changes).
 */
export class LoopClient {
  private session: PairedSession;
  private onUnauthorized?: () => void;
  private readonly carouselPages = new Map<
    string,
    {
      page: ApiConversationPage;
      fetchedAt: number;
    }
  >();
  private readonly carouselRequests = new Map<
    string,
    { version: string; request: Promise<ApiConversationPage> }
  >();

  constructor(session: PairedSession, onUnauthorized?: () => void) {
    this.session = session;
    this.onUnauthorized = onUnauthorized;
  }

  get origin(): string {
    return this.session.origin;
  }

  get currentSession(): PairedSession {
    return this.session;
  }

  /** Auth headers for same-origin file downloads and image previews. */
  fileRequestHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      Origin: this.session.origin,
    };
    if (this.session.cookie) {
      h.Cookie = this.session.cookie;
    }
    return h;
  }

  /** Builds a strictly same-origin URL for a Loop `/api/...` file path. */
  sameOriginFileUrl(path: string, query?: string): string {
    if (!path.startsWith("/api/") || path.startsWith("//")) {
      throw new LoopApiError(400, "Unsupported file path.");
    }
    const url = new URL(
      `${path}${query ? `?${query}` : ""}`,
      this.session.origin,
    );
    if (url.origin !== this.session.origin) {
      throw new LoopApiError(400, "Refused cross-origin file request.");
    }
    return url.toString();
  }

  private headers(isMutation: boolean): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/json",
      Origin: this.session.origin,
    };
    if (this.session.cookie) {
      h.Cookie = this.session.cookie;
    }
    if (isMutation) {
      h["Content-Type"] = "application/json";
      h["X-Loop-CSRF"] = this.session.csrf;
    }
    return h;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const isMutation = method !== "GET";
    const res = await fetchWithTimeout(
      `${this.session.origin}${path}`,
      {
        method,
        headers: this.headers(isMutation),
        credentials: "include",
        redirect: "error",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      timeoutMs,
    );
    assertSameOriginResponse(res, this.session.origin);

    if (res.status === 401) {
      this.onUnauthorized?.();
      throw new LoopApiError(401, "Session expired — pair this phone again.");
    }

    const text = await res.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text };
      }
    }

    if (!res.ok) {
      const msg =
        (parsed as { error?: string; detail?: string })?.error ||
        (parsed as { detail?: string })?.detail ||
        `Request failed (${res.status})`;
      throw new LoopApiError(res.status, msg);
    }
    return parsed as T;
  }

  async refreshSession(): Promise<{ csrf: string }> {
    const data = await this.request<{ csrf: string }>("GET", "/session");
    if (data.csrf) {
      this.session = { ...this.session, csrf: data.csrf };
    }
    return data;
  }

  bootstrap(): Promise<ApiBootstrap> {
    return this.request<ApiBootstrap>("GET", "/api/bootstrap");
  }

  runs(active = true): Promise<
    Array<{
      id: string;
      agent_id: string;
      conversation_id: string | null;
      input: string;
      state: string;
      created_at: number;
      updated_at?: number;
      payload?: string | { connectionId?: string | null } | null;
    }>
  > {
    return this.request("GET", `/api/runs${active ? "?active=1" : ""}`);
  }

  agentDetail(id: string): Promise<{
    agent: import("./types").ApiAgent;
    runs: Array<{
      id: string;
      conversation_id: string | null;
      input: string;
      state: string;
      created_at: number;
    }>;
    conversations: Array<{
      id: string;
      title: string;
      created_at: number;
      project_id: string | null;
    }>;
  }> {
    return this.request("GET", `/api/agents/${encodeURIComponent(id)}`);
  }

  async agentTraces(
    id: string,
    q?: string,
  ): Promise<
    Array<{
      id: string;
      run_id?: string | null;
      kind?: string;
      title?: string | null;
      content?: string | null;
      created_at: number;
    }>
  > {
    const query = q ? `?q=${encodeURIComponent(q)}` : "";
    const data = await this.request<{
      items?: Array<{
        id: string;
        run_id?: string | null;
        kind?: string;
        title?: string | null;
        content?: string | null;
        created_at: number;
      }>;
    }>("GET", `/api/agents/${encodeURIComponent(id)}/traces${query}`);
    return data.items ?? [];
  }

  feed(
    filter: "done" | "working" | "queued" | "replies" | "needs",
    opts?: { folder?: string; agent?: string; before?: string },
  ): Promise<ApiFeedPage> {
    const q = new URLSearchParams({ filter });
    if (opts?.folder) q.set("folder", opts.folder);
    if (opts?.agent) q.set("agent", opts.agent);
    if (opts?.before) q.set("before", opts.before);
    return this.request<ApiFeedPage>("GET", `/api/feed?${q.toString()}`);
  }

  /**
   * Canonical Done cards list (`/api/v1/cards?view=done`), which includes
   * `read_at`, `unread_version`, full untruncated card bodies, and `next` cursor.
   */
  async doneCardsPage(opts?: {
    agent?: string;
    limit?: number;
    before?: string;
  }): Promise<{ items: ApiFeedItem[]; next: string | null }> {
    const q = new URLSearchParams({
      view: "done",
      limit: String(opts?.limit ?? 60),
    });
    if (opts?.agent) q.set("agent", opts.agent);
    if (opts?.before) q.set("before", opts.before);
    const page = await this.request<ApiDoneCardPage>(
      "GET",
      `/api/v1/cards?${q.toString()}`,
    );
    const items = (page.items ?? [])
      .filter((entry) => entry.card?.type === "done" && entry.card.display)
      .map((entry) => {
        const display = entry.card.display;
        const msg = display.last_message;
        return {
          ...display,
          ...(msg
            ? {
                last_message: {
                  ...msg,
                  content:
                    entry.card.content &&
                    entry.card.content.length >= (msg.content?.length ?? 0)
                      ? entry.card.content
                      : msg.content || entry.card.content,
                  saved: entry.card.saved ?? msg.saved,
                },
              }
            : entry.card.content
              ? { live_preview: display.live_preview || entry.card.content }
              : {}),
        };
      });
    return { items, next: page.next ?? null };
  }

  async doneCards(opts?: {
    agent?: string;
    limit?: number;
    before?: string;
  }): Promise<ApiFeedItem[]> {
    const page = await this.doneCardsPage(opts);
    return page.items;
  }

  conversation(id: string, before?: string): Promise<ApiConversationPage> {
    const q = before ? `?before=${encodeURIComponent(before)}` : "";
    return this.request<ApiConversationPage>(
      "GET",
      `/api/conversations/${encodeURIComponent(id)}${q}`,
    );
  }

  carouselPage(id: string, before?: string): Promise<ApiConversationPage> {
    const query = new URLSearchParams({ view: "carousel" });
    if (before) query.set("before", before);
    return this.request<ApiConversationPage>(
      "GET",
      `/api/conversations/${encodeURIComponent(id)}?${query}`,
    );
  }

  // A short-lived snapshot for instant reopen. Only this paired client can
  // see it, and the carousel revalidates it on every open.
  cachedCarouselPage(id: string): ApiConversationPage | undefined {
    const cached = this.carouselPages.get(id);
    if (!cached) return;
    if (Date.now() - cached.fetchedAt > 60_000) return;
    return cached.page;
  }

  refreshCarouselPage(id: string, version = ""): Promise<ApiConversationPage> {
    const pending = this.carouselRequests.get(id);
    if (pending?.version === version) return pending.request;
    const request = this.carouselPage(id)
      .then((page) => {
        if (this.carouselRequests.get(id)?.request !== request) return page;
        this.carouselPages.delete(id);
        // Bound retained transcript size as well as the number of cached pages.
        if (
          page.messages.reduce(
            (length, message) => length + message.content.length,
            0,
          ) <= 300_000
        ) {
          this.carouselPages.set(id, { page, fetchedAt: Date.now() });
          if (this.carouselPages.size > 12) {
            const oldest = this.carouselPages.keys().next().value;
            if (oldest !== undefined) this.carouselPages.delete(oldest);
          }
        }
        return page;
      })
      .finally(() => {
        if (this.carouselRequests.get(id)?.request === request) {
          this.carouselRequests.delete(id);
        }
      });
    this.carouselRequests.set(id, { version, request });
    return request;
  }

  messageDetail(id: string): Promise<ApiMessage> {
    return this.request<ApiMessage>(
      "GET",
      `/api/messages/${encodeURIComponent(id)}`,
    );
  }

  async snippets(): Promise<ApiSnippet[]> {
    const data = await this.request<{ items?: ApiSnippet[] } | ApiSnippet[]>(
      "GET",
      "/api/snippets",
    );
    return Array.isArray(data) ? data : (data.items ?? []);
  }

  async uploadFile(
    file: {
      uri: string;
      name: string;
      mimeType?: string;
      /** Reads the file (see file-bytes.ts); Expo's fetch needs bytes. */
      bytes: () => Promise<Uint8Array>;
    },
    opts?: { agentId?: string; folderId?: string | null },
  ): Promise<UploadedAttachment> {
    const form = new FormData();
    if (opts?.agentId) form.append("agentId", opts.agentId);
    if (opts?.folderId) form.append("folderId", opts.folderId);
    // Expo SDK 58 installs its own fetch globally. Its multipart encoder only
    // accepts a Blob or an object with bytes(); React Native's { uri, name,
    // type } part throws "Unsupported FormDataPart implementation", so the
    // upload never left the phone. Send the picked file's bytes instead and
    // keep the original name and type for the part headers.
    form.append("file", {
      name: file.name || "attachment",
      type: file.mimeType || "application/octet-stream",
      bytes: file.bytes,
    } as unknown as Blob);

    const headers: Record<string, string> = {
      Accept: "application/json",
      Origin: this.session.origin,
      "X-Loop-CSRF": this.session.csrf,
    };
    if (this.session.cookie) {
      headers.Cookie = this.session.cookie;
    }

    const res = await fetchWithTimeout(
      `${this.session.origin}/api/uploads`,
      {
        method: "POST",
        headers,
        credentials: "include",
        redirect: "error",
        body: form,
      },
      UPLOAD_TIMEOUT_MS,
    );
    assertSameOriginResponse(res, this.session.origin);

    if (res.status === 401) {
      this.onUnauthorized?.();
      throw new LoopApiError(401, "Session expired — pair this phone again.");
    }

    const text = await res.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text };
      }
    }

    if (!res.ok) {
      const msg =
        (parsed as { error?: string; detail?: string })?.error ||
        (parsed as { detail?: string })?.detail ||
        `Upload failed (${res.status})`;
      throw new LoopApiError(res.status, msg);
    }
    return parsed as UploadedAttachment;
  }

  async suggestAgentName(): Promise<string> {
    const data = await this.request<{ name: string }>(
      "GET",
      "/api/agents/suggest-name",
    );
    return data.name;
  }

  /** Create an agent with its first task. The idempotency key and name must be
   * reused on retry so an uncertain create returns the same agent. */
  createAgent(input: {
    name: string;
    connectionId: string;
    model: string;
    effort?: string | null;
    initialPrompt: string;
    attachmentIds?: string[];
    folderId?: string | null;
    idempotencyKey: string;
  }): Promise<
    ApiAgent & { initialRun?: { id: string; conversation_id: string | null } }
  > {
    return this.request(
      "POST",
      "/api/agents",
      {
        name: input.name,
        connectionId: input.connectionId,
        model: input.model,
        ...(input.effort != null ? { effort: input.effort } : {}),
        initialPrompt: input.initialPrompt,
        attachmentIds: input.attachmentIds ?? [],
        ...(input.folderId ? { folderId: input.folderId } : {}),
        idempotencyKey: input.idempotencyKey,
      },
      RUN_REQUEST_TIMEOUT_MS,
    );
  }

  updateAgentModel(
    agentId: string,
    selection: AgentModelSelection,
  ): Promise<ApiAgent> {
    return this.request(
      "PATCH",
      `/api/agents/${encodeURIComponent(agentId)}`,
      selection,
    );
  }

  submitRun(input: {
    agentId: string;
    conversationId?: string;
    replyToMessageId?: string;
    folderId?: string | null;
    input: string;
    attachmentIds?: string[];
    idempotencyKey?: string;
    queue?: boolean;
  }): Promise<{ id: string; conversation_id?: string }> {
    return this.request(
      "POST",
      "/api/runs",
      {
        agentId: input.agentId,
        ...(input.conversationId
          ? { conversationId: input.conversationId }
          : {}),
        ...(input.replyToMessageId
          ? { replyToMessageId: input.replyToMessageId }
          : {}),
        ...(input.folderId ? { folderId: input.folderId } : {}),
        ...(input.queue !== undefined ? { queue: input.queue } : {}),
        input: input.input,
        attachmentIds: input.attachmentIds ?? [],
        idempotencyKey: input.idempotencyKey ?? randomUuid(),
      },
      RUN_REQUEST_TIMEOUT_MS,
    );
  }

  runAction(
    runId: string,
    action: "cancel" | "retry" | "dismiss" | "pause" | "resume",
    idempotencyKey?: string,
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/api/runs/${encodeURIComponent(runId)}/${action}`,
      { idempotencyKey: idempotencyKey ?? randomUuid() },
    );
  }

  reorderRun(
    runId: string,
    direction: "up" | "down",
    idempotencyKey?: string,
  ): Promise<{ ok: boolean }> {
    return this.request(
      "POST",
      `/api/runs/${encodeURIComponent(runId)}/reorder`,
      {
        direction,
        idempotencyKey: idempotencyKey ?? randomUuid(),
      },
    );
  }

  markDoneRead(
    conversationId: string,
    cardKey: string,
    unreadVersion?: number,
  ): Promise<{ ok: boolean }> {
    return this.request(
      "PUT",
      `/api/feed/${encodeURIComponent(conversationId)}/read`,
      {
        cardKey,
        ...(unreadVersion !== undefined ? { unreadVersion } : {}),
      },
    );
  }

  setDoneHidden(
    conversationId: string,
    cardKey: string,
    hidden: boolean,
  ): Promise<{ ok: boolean }> {
    return this.request(
      "PATCH",
      `/api/feed/${encodeURIComponent(conversationId)}`,
      { hidden, cardKey },
    );
  }

  setReplyState(
    messageId: string,
    patch: { read?: boolean; archived?: boolean },
  ): Promise<{ ok: boolean }> {
    return this.request(
      "PATCH",
      `/api/replies/${encodeURIComponent(messageId)}`,
      patch,
    );
  }

  async setSaved(
    messageId: string,
    saved: boolean,
    conversationId?: string,
  ): Promise<{ ok: boolean; saved: boolean }> {
    try {
      const result = await this.request<{ ok: boolean; saved: boolean }>(
        saved ? "POST" : "DELETE",
        `/api/messages/${encodeURIComponent(messageId)}/saved`,
        {},
      );
      if (conversationId) {
        const cached = this.carouselPages.get(conversationId);
        if (cached) {
          const ids = new Set(cached.page.saved);
          if (result.saved) ids.add(messageId);
          else ids.delete(messageId);
          this.carouselPages.set(conversationId, {
            ...cached,
            page: { ...cached.page, saved: [...ids] },
          });
        }
        // A GET already in flight may still contain the pre-save state.
        this.carouselRequests.delete(conversationId);
      }
      return result;
    } catch (error) {
      if (conversationId && isUncertainOutcomeError(error)) {
        this.carouselPages.delete(conversationId);
        this.carouselRequests.delete(conversationId);
      }
      throw error;
    }
  }

  createReminder(input: {
    kind: "conversation" | "message";
    targetId: string;
    condition: "time" | "run_finished";
    dueAt?: number;
  }): Promise<unknown> {
    return this.request("POST", "/api/later", input);
  }

  approvals(): Promise<ApiApproval[]> {
    return this.request<ApiApproval[]>("GET", "/api/approvals");
  }

  decideApproval(
    id: string,
    decision: "approve" | "reject",
    idempotencyKey?: string,
  ): Promise<{ ok: boolean }> {
    return this.request("POST", `/api/approvals/${encodeURIComponent(id)}`, {
      decision,
      idempotencyKey: idempotencyKey ?? randomUuid(),
    });
  }

  nativeDecisions(): Promise<ApiNativeDecision[]> {
    return this.request<ApiNativeDecision[]>("GET", "/api/native/decisions");
  }

  answerNativeDecision(
    id: string,
    answer: Record<string, unknown>,
    commandId?: string,
  ): Promise<{ state: string }> {
    return this.request(
      "POST",
      `/api/native/decisions/${encodeURIComponent(id)}`,
      {
        commandId: commandId ?? randomUuid(),
        answer,
      },
    );
  }

  async projectSummaries(): Promise<ApiProjectSummary[]> {
    const data = await this.request<
      | { items?: ApiProjectSummary[]; projects?: ApiProjectSummary[] }
      | ApiProjectSummary[]
    >("GET", "/api/projects/summary");
    if (Array.isArray(data)) return data;
    return data.items ?? data.projects ?? [];
  }

  async githubPulls(): Promise<ApiPullItem[]> {
    const data = await this.request<{
      items?: ApiPullItem[];
      pulls?: ApiPullItem[];
      repos?: Array<{ pulls?: ApiPullItem[] }>;
    }>("GET", "/api/github/pulls");
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.pulls)) return data.pulls;
    if (Array.isArray(data.repos)) {
      return data.repos.flatMap((r) => r.pulls ?? []);
    }
    return [];
  }

  search(
    q: string,
    category?: string,
    before?: number,
  ): Promise<ApiSearchResponse> {
    const params = new URLSearchParams({ q });
    if (category && category !== "all") params.set("category", category);
    if (before !== undefined) params.set("before", String(before));
    return this.request<ApiSearchResponse>(
      "GET",
      `/api/search?${params.toString()}`,
    );
  }

  async savedList(q?: string): Promise<ApiSavedEntry[]> {
    const query = q ? `?q=${encodeURIComponent(q)}` : "";
    const data = await this.request<{ items: ApiSavedEntry[] }>(
      "GET",
      `/api/saved${query}`,
    );
    return data.items ?? [];
  }

  async laterList(): Promise<ApiLaterItem[]> {
    const data = await this.request<{
      due?: ApiLaterItem[];
      upcoming?: ApiLaterItem[];
      items?: ApiLaterItem[];
    }>("GET", "/api/later");
    return [
      ...(data.due ?? []),
      ...(data.upcoming ?? []),
      ...(data.items ?? []),
    ];
  }

  finishLater(id: string): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/api/later/${encodeURIComponent(id)}`, {});
  }

  async scheduledListPage(
    failedBefore?: string,
  ): Promise<{ items: ApiScheduledSend[]; failedNext: string | null }> {
    const query = failedBefore
      ? `?failedBefore=${encodeURIComponent(failedBefore)}`
      : "";
    const data = await this.request<{
      pending?: ApiScheduledSend[];
      failed?: ApiScheduledSend[];
      items?: ApiScheduledSend[];
      failed_next?: string | null;
    }>("GET", `/api/scheduled-sends${query}`);
    return {
      items: [
        ...(data.failed ?? []),
        ...(data.pending ?? []),
        ...(data.items ?? []),
      ],
      failedNext: data.failed_next ?? null,
    };
  }

  async scheduledList(): Promise<ApiScheduledSend[]> {
    const page = await this.scheduledListPage();
    return page.items;
  }

  createScheduledSend(input: {
    agentId: string;
    conversationId?: string;
    folderId?: string | null;
    input: string;
    attachmentIds?: string[];
    replyToMessageId?: string;
    replyExcerpt?: string;
    idempotencyKey: string;
    sendAt: number;
  }): Promise<ApiScheduledSend> {
    return this.request<ApiScheduledSend>(
      "POST",
      "/api/scheduled-sends",
      {
        agentId: input.agentId,
        ...(input.conversationId
          ? { conversationId: input.conversationId }
          : {}),
        ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
        input: input.input,
        attachmentIds: input.attachmentIds ?? [],
        ...(input.replyToMessageId
          ? { replyToMessageId: input.replyToMessageId }
          : {}),
        ...(input.replyExcerpt ? { replyExcerpt: input.replyExcerpt } : {}),
        idempotencyKey: input.idempotencyKey,
        sendAt: input.sendAt,
      },
      RUN_REQUEST_TIMEOUT_MS,
    );
  }

  retryScheduledSend(id: string): Promise<{
    run: {
      id: string;
      conversation_id?: string | null;
      state?: string;
    } | null;
    row: ApiScheduledSend;
  }> {
    return this.request(
      "POST",
      `/api/scheduled-sends/${encodeURIComponent(id)}/retry`,
      {},
      RUN_REQUEST_TIMEOUT_MS,
    );
  }

  cancelScheduled(id: string): Promise<{ ok: boolean }> {
    return this.request(
      "DELETE",
      `/api/scheduled-sends/${encodeURIComponent(id)}`,
      {},
    );
  }

  async personalPrompts(q?: string): Promise<ApiPersonalPrompt[]> {
    const query = q ? `?q=${encodeURIComponent(q)}` : "";
    const data = await this.request<{ items?: ApiPersonalPrompt[] }>(
      "GET",
      `/api/me/prompts${query}`,
    );
    return data.items ?? [];
  }

  async personalFilesPage(opts?: {
    before?: number;
  }): Promise<{ items: PublishedFileItem[]; next: number | null }> {
    const query =
      opts?.before !== undefined
        ? `?before=${encodeURIComponent(String(opts.before))}`
        : "";
    const data = await this.request<{
      items?: ApiPersonalFile[];
      next?: number | null;
    }>("GET", `/api/me/files${query}`);
    const items = (data.items ?? []).map((item) => {
      const meta = parseArtifactFileMetadata(
        item.metadata,
        item.filename || item.title || "Published file",
      );
      return {
        id: item.id,
        artifactId: item.id,
        title: item.title || meta.name,
        name: item.filename || meta.name,
        mime: item.mime || meta.mime,
        size: item.size ?? meta.size,
        isText: meta.isText,
        path: `/api/artifacts/${encodeURIComponent(item.id)}/file`,
        conversationId: item.conversation_id ?? null,
        agentName: item.agent_name ?? null,
        projectName: item.project_name ?? null,
        createdAt: item.created_at,
      };
    });
    return { items, next: data.next ?? null };
  }

  async personalFiles(): Promise<PublishedFileItem[]> {
    const page = await this.personalFilesPage();
    return page.items;
  }

  async runFiles(runId: string): Promise<PublishedFileItem[]> {
    const items = await this.request<ApiRunFile[]>(
      "GET",
      `/api/runs/${encodeURIComponent(runId)}/files`,
    );
    return (Array.isArray(items) ? items : []).map((item) => {
      const meta = parseArtifactFileMetadata(item.metadata, item.title);
      return {
        id: item.id,
        artifactId: item.id,
        title: item.title || meta.name,
        name: meta.name,
        mime: meta.mime,
        size: meta.size,
        isText: meta.isText,
        path: `/api/artifacts/${encodeURIComponent(item.id)}/file`,
      };
    });
  }

  artifactDetail(id: string): Promise<ApiArtifactDetail> {
    return this.request<ApiArtifactDetail>(
      "GET",
      `/api/artifacts/${encodeURIComponent(id)}`,
    );
  }

  async fetchFileTextPreview(
    path: string,
    maxChars = 100_000,
  ): Promise<{
    text: string;
    name?: string;
    mime?: string;
    truncated: boolean;
  }> {
    const url = this.sameOriginFileUrl(path);
    const res = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: this.fileRequestHeaders(),
        credentials: "include",
        redirect: "error",
      },
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    assertSameOriginResponse(res, this.session.origin);
    if (res.status === 401) {
      this.onUnauthorized?.();
      throw new LoopApiError(401, "Session expired — pair this phone again.");
    }
    if (!res.ok) {
      throw new LoopApiError(
        res.status,
        `Could not load file (${res.status}).`,
      );
    }
    const raw = await res.text();
    return {
      text: raw.length > maxChars ? raw.slice(0, maxChars) : raw,
      truncated: raw.length > maxChars,
      name: parseContentDispositionFilename(
        res.headers.get("content-disposition"),
      ),
      mime: res.headers.get("content-type") || undefined,
    };
  }

  personalProfile(): Promise<ApiPersonalProfile> {
    return this.request<ApiPersonalProfile>("GET", "/api/me/profile");
  }

  async socialStories(): Promise<ApiSocialStory[]> {
    const data = await this.request<{ stories?: ApiSocialStory[] }>(
      "GET",
      "/api/social",
    );
    return data.stories ?? [];
  }

  socialMarkRead(ids: string[]): Promise<{ unread: number }> {
    return this.request("POST", "/api/social/read", { ids });
  }

  socialDismiss(ids: string[]): Promise<{ unread: number }> {
    return this.request("POST", "/api/social/dismiss", { ids });
  }

  sharePreview(input: {
    question: string;
    source?: { url: string; title: string; excerpt: string };
    sharedText?: string;
    folderId?: string;
  }): Promise<ApiSharePreview> {
    return this.request<ApiSharePreview>("POST", "/api/share/preview", input);
  }

  shareSend(input: {
    question: string;
    source?: { url: string; title: string; excerpt: string };
    sharedText?: string;
    folderId?: string;
    newAgentId?: string;
    attachmentIds?: string[];
    idempotencyKey: string;
  }): Promise<{ id: string; conversation_id?: string }> {
    return this.request<{ id: string; conversation_id?: string }>(
      "POST",
      "/api/share/send",
      input,
      RUN_REQUEST_TIMEOUT_MS,
    );
  }

  async signOut(): Promise<void> {
    try {
      await this.request("POST", "/api/auth/sign-out", {});
    } catch {
      // Clear local session regardless
    }
  }
}
