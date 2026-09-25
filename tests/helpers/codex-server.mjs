// Deterministic app-server protocol fixture. Never imported by production code.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
export const fixtureToken = "fixture-codex-access-token-at-least-32-characters";
export async function codexFixture() {
  const calls = [],
    sockets = new Set();
  let mode = "answer",
    sequence = 0;
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket) => {
    if (req.headers.authorization !== "Bearer " + fixtureToken) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(
        req.headers["sec-websocket-key"] +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    const send = (message) => {
      const data = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(data.length < 126 ? 2 : 4);
      header[0] = 0x81;
      header[1] = data.length < 126 ? data.length : 126;
      if (data.length >= 126) header.writeUInt16BE(data.length, 2);
      socket.write(Buffer.concat([header, data]));
    };
    let initialized = false,
      model,
      threadId,
      turnId;
    const receive = (message) => {
      calls.push(message);
      if (!message.method || message.id == null) return;
      if (!initialized && message.method !== "initialize") {
        send({
          id: message.id,
          error: { code: -32000, message: "Not initialized" },
        });
        return;
      }
      let result = {};
      if (message.method === "initialize") initialized = true;
      if (message.method === "account/read")
        result = {
          account:
            mode === "signed-out"
              ? null
              : {
                  type: mode === "api-key" ? "apiKey" : "chatgpt",
                  planType: "fixture",
                },
        };
      if (message.method === "model/list")
        result = {
          data: [
            {
              id: "fixture",
              model: "fixture",
              displayName: "Remote Codex fixture",
            },
          ],
          nextCursor: null,
        };
      if (message.method === "skills/list")
        result = {
          data: [
            {
              cwd: "/fixture",
              skills: [
                {
                  name: "fixture-skill",
                  path: "/fixture/SKILL.md",
                  description: "Review fixture code",
                  enabled: true,
                },
                {
                  name: "disabled-skill",
                  path: "/disabled/SKILL.md",
                  enabled: false,
                },
              ],
              errors: [],
            },
          ],
        };
      if (message.method === "config/read")
        result = {
          config: {
            mcp_servers: {
              "unsafe.host": {
                command: "must-not-run",
                tool_timeout_sec: null,
              },
            },
          },
        };
      if (message.method === "thread/start") {
        model = message.params.model;
        threadId = `fixture-thread-${++sequence}`;
        result = {
          thread: { id: threadId },
          modelProvider: model === "wrong-provider" ? "unexpected" : "openai",
          approvalPolicy: "never",
          sandbox: {
            type: "dangerFullAccess",
          },
        };
      }
      if (["turn/start", "review/start"].includes(message.method)) {
        turnId = `fixture-turn-${sequence}`;
        result = { turn: { id: turnId } };
      }
      send({ id: message.id, result });
      if (!["turn/start", "review/start"].includes(message.method)) return;
      if (message.method === "review/start") {
        send({
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item: {
              type: "exitedReviewMode",
              review: "Native review completed.",
            },
          },
        });
        send({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed" } },
        });
        return;
      }
      if (model === "disconnect") {
        socket.destroy();
        return;
      }
      if (model === "wait") return;
      send({
        method: "item/agentMessage/delta",
        params: {
          threadId: "someone-elses-thread",
          turnId,
          delta: "PRIVATE OTHER SESSION",
        },
      });
      send({
        method: "turn/completed",
        params: { threadId, turn: { id: "old-turn", status: "completed" } },
      });
      send({
        id: 1000,
        method: "item/commandExecution/requestApproval",
        params: { threadId, turnId, command: "fixture-native-command" },
      });
      send({
        id: 1001,
        method: "item/fileChange/requestApproval",
        params: { threadId, turnId },
      });
      send({
        id: 1002,
        method: "item/permissions/requestApproval",
        params: {
          threadId,
          turnId,
          permissions: { network: { enabled: true } },
        },
      });
      send({
        id: 1003,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "someone-elses-thread", turnId },
      });
      const answer = {
        kind: model === "tool" || model === "ungranted" ? "tool" : "answer",
        text: "Remote Codex fixture response.",
        tool:
          model === "tool"
            ? "lookup"
            : model === "ungranted"
              ? "forbidden"
              : null,
        arguments: "{}",
      };
      send({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, delta: JSON.stringify(answer) },
      });
      send({
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: turnId,
            status: model === "quota" ? "failed" : "completed",
          },
        },
      });
    };
    // Only text/close frames are needed for this fixture. Decode masked client
    // frames, retaining incomplete frames across TCP reads.
    let buffer = Buffer.alloc(0);
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 2) {
        let length = buffer[1] & 127,
          offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        if (length === 127) {
          socket.destroy();
          return;
        }
        const masked = !!(buffer[1] & 128),
          opcode = buffer[0] & 15;
        if (!masked || length > 60000) {
          socket.destroy();
          return;
        }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4),
          payload = Buffer.from(
            buffer.subarray(offset + 4, offset + 4 + length),
          );
        buffer = buffer.subarray(offset + 4 + length);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (opcode === 8) {
          socket.end(Buffer.from([0x88, 0]));
          return;
        }
        if (opcode === 1) receive(JSON.parse(payload.toString()));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    token: fixtureToken,
    calls,
    setMode(value) {
      mode = value;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
