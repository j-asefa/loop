/** Read the signed-in account from the worker-owned shared Codex app-server. */
export async function inspectCodexAppServer({ endpoint, token, WebSocketCtor, timeoutMs = 15000 }) {
  if (!endpoint || !token || !WebSocketCtor)
    throw new Error("Shared Codex app-server is unavailable");
  const socket = new WebSocketCtor(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
    perMessageDeflate: false,
    handshakeTimeout: 10_000,
  });
  const pending = new Map();
  let sequence = 0;
  let connected = false;
  let timer;
  let rejectTimeout;
  const timedOut = new Promise((_, reject) => { rejectTimeout = reject; });
  timer = setTimeout(() => rejectTimeout(new Error("Shared Codex app-server timed out")), timeoutMs);
  const disconnected = new Promise((_, reject) => {
    socket.on("close", () => {
      for (const request of pending.values()) request.reject(new Error("Shared Codex app-server disconnected"));
      pending.clear();
      if (!connected) reject(new Error("Shared Codex app-server disconnected"));
    });
    socket.on("error", (error) => {
      if (!connected) reject(new Error("Shared Codex app-server unavailable", { cause: error }));
    });
  });
  const open = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", (error) => reject(new Error("Shared Codex app-server unavailable", { cause: error })));
  });
  socket.on("message", (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error("Codex account status request was rejected"));
    else request.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  try {
    await Promise.race([open, disconnected, timedOut]);
    connected = true;
    await Promise.race([
      request("initialize", { clientInfo: { name: "loop55-auth", version: "1" } }),
      disconnected,
      timedOut,
    ]);
    socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
    const [account, configResult, modelResult] = await Promise.race([
      Promise.all([
        request("account/read", { refreshToken: true }),
        request("config/read", { includeLayers: false }),
        request("model/list", { includeHidden: false }),
      ]),
      disconnected,
      timedOut,
    ]);
    const config = configResult?.config;
    const authenticated = account?.account?.type === "chatgpt" &&
      config?.forced_login_method === "chatgpt" &&
      (!config.model_provider || config.model_provider === "openai") &&
      !Object.keys(config.model_providers?.openai || {}).length;
    const models = authenticated && Array.isArray(modelResult?.data) ? modelResult.data : [];
    return {
      authenticated,
      authMethod: account?.account?.type || "unknown",
      managed: true,
      checkedAt: Date.now(),
      models: models.map((model) => ({
        id: model.model || model.id,
        name: model.displayName || model.model || model.id,
        capabilities: "Native Codex",
      })),
    };
  } finally {
    clearTimeout(timer);
    for (const request of pending.values()) request.reject(new Error("Codex status inspection finished"));
    pending.clear();
    socket.close();
  }
}
