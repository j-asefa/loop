import type {
  ApiApproval,
  ApiBootstrap,
  ApiConversationPage,
  ApiFeedPage,
  ApiLaterItem,
  ApiMessage,
  ApiNativeDecision,
  ApiPersonalFile,
  ApiPersonalProfile,
  ApiPersonalPrompt,
  ApiProjectSummary,
  ApiPullItem,
  ApiSavedEntry,
  ApiScheduledSend,
  ApiSearchResponse,
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

/**
 * Typed HTTP client talking directly to a paired Loop companion server over
 * Loop's native cookie + Origin + X-Loop-CSRF protocol (zero server changes).
 */
export class LoopClient {
  private session: PairedSession;
  private onUnauthorized?: () => void;

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
  ): Promise<T> {
    const isMutation = method !== "GET";
    const res = await fetch(`${this.session.origin}${path}`, {
      method,
      headers: this.headers(isMutation),
      credentials: "include",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

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

  conversation(id: string, before?: string): Promise<ApiConversationPage> {
    const q = before ? `?before=${encodeURIComponent(before)}` : "";
    return this.request<ApiConversationPage>(
      "GET",
      `/api/conversations/${encodeURIComponent(id)}${q}`,
    );
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
    file: { uri: string; name: string; mimeType?: string },
    opts?: { agentId?: string; folderId?: string | null },
  ): Promise<UploadedAttachment> {
    const form = new FormData();
    if (opts?.agentId) form.append("agentId", opts.agentId);
    if (opts?.folderId) form.append("folderId", opts.folderId);
    form.append("file", {
      uri: file.uri,
      name: file.name || "attachment",
      type: file.mimeType || "application/octet-stream",
    } as unknown as Blob);

    const headers: Record<string, string> = {
      Accept: "application/json",
      Origin: this.session.origin,
      "X-Loop-CSRF": this.session.csrf,
    };
    if (this.session.cookie) {
      headers.Cookie = this.session.cookie;
    }

    const res = await fetch(`${this.session.origin}/api/uploads`, {
      method: "POST",
      headers,
      credentials: "include",
      body: form,
    });

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

  submitRun(input: {
    agentId: string;
    conversationId?: string;
    replyToMessageId?: string;
    folderId?: string | null;
    input: string;
    attachmentIds?: string[];
    idempotencyKey?: string;
  }): Promise<{ id: string; conversation_id?: string }> {
    return this.request("POST", "/api/runs", {
      agentId: input.agentId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.replyToMessageId
        ? { replyToMessageId: input.replyToMessageId }
        : {}),
      ...(input.folderId ? { folderId: input.folderId } : {}),
      input: input.input,
      attachmentIds: input.attachmentIds ?? [],
      idempotencyKey: input.idempotencyKey ?? randomUuid(),
    });
  }

  runAction(
    runId: string,
    action: "cancel" | "retry" | "dismiss",
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/api/runs/${encodeURIComponent(runId)}/${action}`,
      { idempotencyKey: randomUuid() },
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

  setSaved(
    messageId: string,
    saved: boolean,
  ): Promise<{ ok: boolean; saved: boolean }> {
    return this.request(
      saved ? "POST" : "DELETE",
      `/api/messages/${encodeURIComponent(messageId)}/saved`,
      {},
    );
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
  ): Promise<{ ok: boolean }> {
    return this.request("POST", `/api/approvals/${encodeURIComponent(id)}`, {
      decision,
      idempotencyKey: randomUuid(),
    });
  }

  nativeDecisions(): Promise<ApiNativeDecision[]> {
    return this.request<ApiNativeDecision[]>("GET", "/api/native/decisions");
  }

  answerNativeDecision(
    id: string,
    answer: Record<string, unknown>,
  ): Promise<{ state: string }> {
    return this.request(
      "POST",
      `/api/native/decisions/${encodeURIComponent(id)}`,
      {
        commandId: randomUuid(),
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

  search(q: string, category?: string): Promise<ApiSearchResponse> {
    const params = new URLSearchParams({ q });
    if (category && category !== "all") params.set("category", category);
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

  async scheduledList(): Promise<ApiScheduledSend[]> {
    const data = await this.request<{
      pending?: ApiScheduledSend[];
      failed?: ApiScheduledSend[];
      items?: ApiScheduledSend[];
    }>("GET", "/api/scheduled-sends");
    return [
      ...(data.failed ?? []),
      ...(data.pending ?? []),
      ...(data.items ?? []),
    ];
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

  async personalFiles(): Promise<ApiPersonalFile[]> {
    const data = await this.request<{ items?: ApiPersonalFile[] }>(
      "GET",
      "/api/me/files",
    );
    return data.items ?? [];
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

  async signOut(): Promise<void> {
    try {
      await this.request("POST", "/api/auth/sign-out", {});
    } catch {
      // Clear local session regardless
    }
  }
}
