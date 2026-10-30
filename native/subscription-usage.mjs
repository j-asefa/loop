import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const windowValue = (value) =>
  Number.isFinite(value?.used_percentage) &&
  value.used_percentage >= 0 && value.used_percentage <= 100
    ? {
        usedPercent: value.used_percentage,
        resetsAt: Number.isFinite(value.resets_at)
          ? new Date(value.resets_at * 1000).toISOString()
          : null,
      }
    : null;

export function claudeUsageFile(configDir) {
  return join(configDir, "loop55-subscription-usage.json");
}

export async function captureClaudeUsage(input, file) {
  const data = JSON.parse(input);
  const fiveHour = windowValue(data.rate_limits?.five_hour);
  const sevenDay = windowValue(data.rate_limits?.seven_day);
  if (!fiveHour && !sevenDay) return false;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ observedAt: new Date().toISOString(), fiveHour, sevenDay }), { mode: 0o600 });
  await rename(temporary, file);
  return true;
}

export async function readClaudeUsage(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    const valid = (value) => value && (!value.resetsAt || Date.parse(value.resetsAt) > Date.now()) ? value : null;
    const fiveHour = valid(data.fiveHour);
    const sevenDay = valid(data.sevenDay);
    if (!fiveHour && !sevenDay) return { status: "unavailable" };
    return { status: "cached", observedAt: data.observedAt, fiveHour, sevenDay };
  } catch {
    return { status: "unavailable" };
  }
}

export function configureClaudeUsage(configDir, hookPath) {
  const file = join(configDir, "settings.json");
  let settings = {};
  if (existsSync(file)) {
    try { settings = JSON.parse(readFileSync(file, "utf8")); }
    catch { return false; }
  }
  if (settings.statusLine) return false;
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const quoted = `'${hookPath.replaceAll("'", "'\\''")}'`;
  settings.statusLine = { type: "command", command: `node ${quoted} '${claudeUsageFile(configDir).replaceAll("'", "'\\''")}'` };
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  return true;
}

export async function readCodexUsage({ endpoint, token, WebSocketCtor, timeoutMs = 12000 }) {
  if (!endpoint || !token || !WebSocketCtor) return { status: "unavailable" };
  const socket = new WebSocketCtor(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
    perMessageDeflate: false,
    handshakeTimeout: timeoutMs,
  });
  let sequence = 0;
  const pending = new Map();
  let closed = false;
  const fail = () => {
    closed = true;
    for (const item of pending.values()) item.reject(new Error("Codex app-server disconnected"));
    pending.clear();
  };
  socket.on("close", fail);
  socket.on("error", fail);
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  socket.on("message", (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error("Codex rate limits unavailable"));
    else item.resolve(message.result);
  });
  const timer = setTimeout(() => socket.terminate(), timeoutMs);
  try {
    await new Promise((resolve, reject) => {
      if (closed) return reject(new Error("Codex app-server unavailable"));
      socket.once("open", resolve);
      socket.once("close", () => reject(new Error("Codex app-server unavailable")));
      socket.once("error", reject);
    });
    await request("initialize", { clientInfo: { name: "loop55-subscription-usage", version: "1" } });
    socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
    const result = await request("account/rateLimits/read");
    const project = (item) => item && ({
      limitId: item.limitId,
      limitName: item.limitName,
      primary: item.primary && { usedPercent: item.primary.usedPercent, windowDurationMins: item.primary.windowDurationMins, resetsAt: Number.isFinite(item.primary.resetsAt) ? new Date(item.primary.resetsAt * 1000).toISOString() : null },
      secondary: item.secondary && { usedPercent: item.secondary.usedPercent, windowDurationMins: item.secondary.windowDurationMins, resetsAt: Number.isFinite(item.secondary.resetsAt) ? new Date(item.secondary.resetsAt * 1000).toISOString() : null },
    });
    return {
      status: "live", observedAt: new Date().toISOString(),
      rateLimits: project(result?.rateLimits),
      rateLimitsByLimitId: Object.fromEntries(Object.entries(result?.rateLimitsByLimitId || {}).map(([id, value]) => [id, project(value)])),
    };
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}
