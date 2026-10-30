// Explicit browser fixture service. Never imported by production code.
import { createServer } from "node:http";
if (process.env.NODE_ENV !== "test") throw Error("Test-only fixture");
const accounts = new Map();
createServer(async (req, res) => {
  if (req.url?.startsWith("/native/")) {
    res.setHeader("content-type", "application/json");
    if (
      req.headers.authorization !==
      "Bearer native-browser-fixture-token-at-least-32-characters"
    ) {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    if (req.url === "/native/health") {
      res.end(JSON.stringify({ ok: true, kind: "native-host" }));
      return;
    }
    let input = "";
    for await (const chunk of req) input += chunk;
    const request = JSON.parse(input);
    if (["login", "status"].includes(request.action))
      res.end(
        JSON.stringify({
          authenticated: true,
          authMode: "subscription",
          models: [
            {
              id: "sonnet",
              name: "Sonnet fixture",
              capabilities: "Native host fixture",
            },
          ],
        }),
      );
    else if (request.action === "capabilities")
      res.end(
        JSON.stringify({
          available: true,
          runtime: "Claude Code",
          commands: [
            {
              name: "fixture-command",
              token: "/fixture-command",
              kind: "command",
              description: "Fixture skill on this machine",
              argumentHint: "task",
            },
          ],
        }),
      );
    else if (request.action === "turn")
      res.end(
        JSON.stringify({ chunk: { text: "Native Claude fixture response." } }) +
          "\n" +
          JSON.stringify({ done: true }) +
          "\n",
      );
    else res.end(JSON.stringify({ ok: true }));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const d = JSON.parse(raw),
    a = accounts.get(d.key) || { state: "none", polls: 0 };
  accounts.set(d.key, a);
  res.setHeader("content-type", "application/json");
  const send = (value) => res.end(JSON.stringify(value));
  if (d.action === "login") {
    a.state = "waiting";
    a.polls = 0;
    send({ state: "starting" });
    return;
  }
  if (d.action === "code") {
    if (d.code !== "fixture-code") {
      res.statusCode = 400;
      send({ error: "Wrong fixture code" });
      return;
    }
    a.state = "connected";
    send({ ok: true });
    return;
  }
  if (d.action === "cancel" || d.action === "logout") {
    a.state = "none";
    send({ authenticated: false });
    return;
  }
  if (d.action === "status") {
    if (a.state === "waiting") {
      if (d.provider === "codex" && ++a.polls >= 3) a.state = "connected";
      else {
        send({
          state: "waiting",
          login: {
            url:
              d.provider === "codex"
                ? "https://auth.openai.com/codex/device"
                : "https://claude.com/cai/oauth/authorize?fixture=1",
            code: d.provider === "codex" ? "FIXTURE-123" : undefined,
            acceptsCode: d.provider === "claude",
          },
        });
        return;
      }
    }
    send({
      authenticated: a.state === "connected",
      authMode: a.state === "connected" ? "subscription" : "none",
      plan: "Fixture only",
      models: [
        {
          id: "subscription-fixture",
          name: "Subscription fixture",
          capabilities: "Deterministic fixture only",
        },
      ],
    });
    return;
  }
  if (d.action === "turn") {
    if (a.state !== "connected") {
      res.statusCode = 401;
      send({ error: "Not signed in" });
      return;
    }
    const tools = d.input.tools?.filter((t) =>
      t.name.startsWith("loop55_tool_"),
    );
    if (tools?.length && !d.input.messages.some((m) => m.role === "tool"))
      res.write(
        JSON.stringify({
          chunk: {
            toolCall: {
              id: "subscription-tool",
              name: tools[0].name,
              arguments: { query: "fixture latency" },
            },
          },
        }) + "\n",
      );
    else
      res.write(
        JSON.stringify({
          chunk: {
            text: "Subscription fixture response. No live provider was called.",
          },
        }) + "\n",
      );
    res.end(JSON.stringify({ done: true }) + "\n");
    return;
  }
  res.statusCode = 400;
  send({ error: "Unsupported fixture action" });
}).listen(Number(process.env.LOOP55_FIXTURE_BROKER_PORT || 3109), "127.0.0.1");
