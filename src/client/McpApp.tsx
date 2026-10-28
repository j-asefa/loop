import { routeUrl } from "./workspace-api";
import { workspaceApi } from "../shared/workspace-api";
import { useSourceId, useSourceRoute } from "./SourceContext";
import { useEffect, useRef, useState } from "react";
import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
export function McpApp({
  artifactId,
  metadata,
}: {
  artifactId: string;
  metadata?: any;
}) {
  const call = useSourceRoute();
  const sourceId = useSourceId();
  const frame = useRef<HTMLIFrameElement>(null),
    [status, setStatus] = useState("Loading isolated app…");
  useEffect(() => {
    const f = frame.current!;
    const bridge = new AppBridge(
      null,
      { name: "Loop", version: "0.1.0" },
      { serverTools: {}, logging: {} },
    );
    let ready = false;
    bridge.oncalltool = async (params) => {
      try {
        const r = await call(workspaceApi.artifactToolCall, {
          params: { id: artifactId },
          body: {
            tool: params.name,
            arguments: params.arguments || {},
            idempotencyKey: crypto.randomUUID(),
          },
        });
        setStatus("Tool request queued. Review it in Running.");
        return {
          content: [
            {
              type: "text",
              text:
                "Request queued for explicit approval in Loop Running. Run ID: " +
                r.id,
            },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: "text", text: (e as Error).message }],
        };
      }
    };
    bridge.oninitialized = () => {
      ready = true;
      setStatus("App connected. Requests still require your approval.");
      // Interactive app payload stays on its signed-in, source-bound route.
      // The public content contract carries only the capability flag.
      void (
        metadata
          ? Promise.resolve(metadata)
          : call(workspaceApi.artifactDetail, {
              params: { id: artifactId },
            }).then((item) => JSON.parse(item.metadata))
      )
        .then(async (payload) => {
          await bridge.sendToolInput({ arguments: payload.arguments || {} });
          await bridge.sendToolResult(payload.toolResult);
        })
        .catch(() =>
          setStatus(
            "The app could not display this result. The saved snapshot is available below.",
          ),
        );
    };
    void bridge
      .connect(new PostMessageTransport(f.contentWindow!, f.contentWindow!))
      .then(() => {
        f.src = routeUrl(
          workspaceApi.artifactApp,
          { params: { id: artifactId } },
          sourceId,
        );
      })
      .catch(() => setStatus("App unavailable. Use the saved snapshot below."));
    const timeout = setTimeout(() => {
      if (!ready)
        setStatus(
          "This app needs capabilities Loop does not grant. Use the saved result below.",
        );
    }, 7000);
    return () => {
      clearTimeout(timeout);
      void bridge.close();
    };
  }, [artifactId]);
  return (
    <section className="mcp-app">
      <p className="field-hint">{status}</p>
      <iframe
        ref={frame}
        title="MCP app, isolated from Loop"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
    </section>
  );
}
