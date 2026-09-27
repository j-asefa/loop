import { Problem } from "../domain.js";

export class InactiveSessionError extends Problem {
  constructor() {
    super(409, "Native session is inactive; resume it before sending work");
  }
}

// Private app-to-Hub client. Mutations are never retried after transport failure.
export class HapiClient {
  private token = "";
  private expires = 0;
  private authenticating?: Promise<void>;
  constructor(
    readonly url: string,
    private accessToken: string,
    private fetcher = fetch,
  ) {}
  async authenticate() {
    if (this.expires > Date.now()) return;
    if (!this.authenticating)
      this.authenticating = (async () => {
        const r = await this.fetcher(this.url + "/api/auth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accessToken: this.accessToken }),
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        });
        if (!r.ok)
          throw new Problem(
            503,
            "Private execution coordinator is unavailable",
          );
        const data = await r.json();
        if (typeof data.token !== "string")
          throw new Error("Invalid HAPI auth response");
        this.token = data.token;
        this.expires = Date.now() + 3 * 3600000;
      })().finally(() => {
        this.authenticating = undefined;
      });
    await this.authenticating;
  }
  async request(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ): Promise<any> {
    await this.authenticate();
    const r = await this.fetcher(this.url + path, {
      method,
      headers: {
        authorization: "Bearer " + this.token,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(35000),
      redirect: "error",
    });
    if (r.status === 401) this.expires = 0;
    const result = await r.json();
    if (r.status === 409 && result.code === "session_inactive")
      throw new InactiveSessionError();
    if (
      !r.ok ||
      result.type === "error" ||
      result.success === false ||
      result.type === "requestToApproveDirectoryCreation"
    )
      throw new Problem(
        503,
        "Native coordinator rejected the operation; reconcile before retrying",
      );
    return result;
  }
  async events(
    cursor: string | null,
    signal: AbortSignal,
    handle: (data: any, id: string | null) => Promise<void>,
  ) {
    await this.authenticate();
    const response = await this.fetcher(this.url + "/api/events?all=true", {
      headers: {
        authorization: "Bearer " + this.token,
        ...(cursor ? { "Last-Event-ID": cursor } : {}),
      },
      signal,
      redirect: "error",
    });
    if (!response.ok || !response.body)
      throw new Error("HAPI stream unavailable");
    let buffer = "",
      lastId: string | null = null,
      lines: string[] = [];
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > 8 * 1024 * 1024)
        throw new Error("Oversized HAPI frame");
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!line) {
          if (lines.length) await handle(JSON.parse(lines.join("\n")), lastId);
          lines = [];
          lastId = null;
        } else if (line.startsWith("data:"))
          lines.push(line.slice(5).trimStart());
        else if (line.startsWith("id:")) lastId = line.slice(3).trim();
      }
    }
  }
}
