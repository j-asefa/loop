import "../runtime/environment.mjs";
// Loaded process-locally by `loop55 pi`. No credentials, model overrides or settings writes.
import { writeSync } from "node:fs";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
export default function loop55Metadata(pi) {
  let toolsReady = !process.env.LOOP55_TOOLS_URL;
  const describe = (ctx) => {
    const model = ctx.model;
    const provider = model && ctx.modelRegistry.getProvider(model.provider);
    return {
      toolsReady,
      projectTrusted: ctx.isProjectTrusted(),
      toolsTruncated: pi.getAllTools().length > 150,
      // Send display metadata only. Schemas and settings may contain secrets.
      tools: pi
        .getAllTools()
        .slice(0, 150)
        .map((tool) => ({
          name: tool.name,
          description: String(tool.description || "").slice(0, 160),
          sourceInfo: tool.sourceInfo,
          active: pi.getActiveTools().includes(tool.name),
        })),
      provider: model?.provider,
      model: model?.id,
      modelEfforts: ctx.modelRegistry.getAvailable().map((available) => ({
        id: `${available.provider}/${available.id}`,
        levels: getSupportedThinkingLevels(available),
      })),
      // Only confirmed subscriptions: aggregator catalogs list hundreds of
      // models, and Loop55 treats an absent entry as not a subscription.
      modelBilling: ctx.modelRegistry
        .getAvailable()
        .filter(
          (available) =>
            ctx.modelRegistry.isUsingOAuth(available) &&
            ctx.modelRegistry.getProvider(available.provider)?.auth?.oauth
              ?.isSubscription === true,
        )
        .map((available) => ({
          id: `${available.provider}/${available.id}`,
          subscription: true,
        })),
      configured: !!model && ctx.modelRegistry.hasConfiguredAuth(model),
      subscription:
        !!model &&
        ctx.modelRegistry.isUsingOAuth(model) &&
        provider?.auth?.oauth?.isSubscription === true,
    };
  };
  const report = (ctx) => writeSync(3, JSON.stringify(describe(ctx)) + "\n");
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.LOOP55_TOOLS_URL) {
      try {
        const call = async (body, signal) => {
          const response = await fetch(process.env.LOOP55_TOOLS_URL + "/pi", {
            method: "POST",
            signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + process.env.LOOP55_TOOLS_TOKEN,
            },
            body: JSON.stringify(body),
          });
          if (!response.ok)
            throw new Error("Loop55 workspace tool connection ended");
          return response.json();
        };
        const catalog = await call(
          { method: "tools/list" },
          AbortSignal.timeout(10000),
        );
        for (const tool of catalog.tools)
          pi.registerTool({
            name: tool.name,
            label: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            async execute(id, args, signal) {
              const result = await call(
                { method: "tools/call", id, name: tool.name, arguments: args },
                signal,
              );
              if (result.isError)
                throw new Error(
                  (result.content || [])
                    .filter((x) => x.type === "text")
                    .map((x) => x.text)
                    .join("\n") || "Workspace tool failed",
                );
              return {
                content: result.content || [],
                details: { workspace: true },
              };
            },
          });
        toolsReady = true;
      } catch {
        toolsReady = false;
      }
    }
    report(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    report(ctx);
  });
  pi.registerCommand("loop55-status", {
    description: "Report safe provider metadata to Loop55",
    handler: async (_args, ctx) => {
      report(ctx);
    },
  });
  pi.on("input", (_event, ctx) => {
    const info = describe(ctx);
    if (
      process.env.LOOP55_BILLING_MODE === "subscription" &&
      !info.subscription
    ) {
      report(ctx);
      ctx.ui.notify(
        "Loop55 refused this prompt: the effective Pi provider is not a confirmed subscription.",
        "error",
      );
      return { action: "handled" };
    }
    return { action: "continue" };
  });
}
