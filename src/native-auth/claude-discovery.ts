import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { Native } from "../native.js";
import { modelOptions } from "../../runtime/model-options.mjs";

/** Runner-local catalog probe: initializes Claude Code, never sends a prompt. */
export async function discoverClaudeModels(options: {
  executable: string;
  project: string;
  env: NodeJS.ProcessEnv;
}) {
  if (
    !isAbsolute(options.executable) ||
    !isAbsolute(options.project) ||
    !options.env
  )
    throw new Error(
      "Claude discovery requires runner-resolved paths and environment",
    );
  const native = new Native(
    options.executable,
    [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-prompt-tool",
      "stdio",
      "--no-session-persistence",
    ],
    options.project,
    options.env,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const requestId = randomUUID();
    const init: any = await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Claude model discovery timed out")),
        15000,
      );
      native.once("failure", () =>
        reject(new Error("Claude model discovery failed")),
      );
      native.on("message", (message) => {
        if (
          message.type !== "control_response" ||
          message.response?.request_id !== requestId
        )
          return;
        if (message.response.subtype !== "success")
          reject(new Error("Claude model discovery was rejected"));
        else resolve(message.response.response);
      });
      void native
        .write({
          type: "control_request",
          request_id: requestId,
          request: { subtype: "initialize" },
        })
        .catch(reject);
    });
    if (!Array.isArray(init?.models) || !init.models.length)
      throw new Error("Claude Code did not report its model catalog");
    const models = init.models.flatMap((model: any) => {
      const id = model.value || model.id;
      const name = model.displayName || model.name || id;
      return typeof id === "string" &&
        id.length > 0 &&
        id.length <= 150 &&
        typeof name === "string"
        ? [{ id, name: name.slice(0, 200), ...modelOptions(model) }]
        : [];
    });
    if (!models.length)
      throw new Error("Claude Code reported no usable models");
    return [
      { id: "default", name: "Use native default" },
      ...models.filter((model: { id: string }) => model.id !== "default"),
    ];
  } finally {
    clearTimeout(timer);
    await native.dispose();
  }
}


/** Authentication evidence remains available when the optional catalog fails. */
export async function claudeAuthStatus(
  status: { loggedIn?: boolean; authMethod?: string; apiProvider?: string },
  discover?: () => Promise<unknown[]>,
) {
  const authenticated = status.loggedIn === true &&
    ["claude.ai", "oauth"].includes(status.authMethod || "") && status.apiProvider === "firstParty";
  let catalog: { models?: unknown[]; modelsError?: string } = {};
  if (authenticated && discover) {
    try { catalog = { models: await discover() }; }
    catch { catalog = { modelsError: "Claude model discovery is unavailable. Refresh to try again." }; }
  }
  return { authenticated, authMethod: "claude", managed: true, ...catalog, checkedAt: Date.now() };
}
