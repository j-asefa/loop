import { useEffect, useRef, useState } from "react";
import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { api } from "./api";
export function McpApp({
  artifactId,
  metadata,
}: {
  artifactId: string;
  metadata: any;
}) {
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
        const r = await api("/artifacts/" + artifactId + "/tool-call", {
          tool: params.name,
          arguments: params.arguments || {},
          idempotencyKey: crypto.randomUUID(),
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
      void bridge
        .sendToolInput({ arguments: metadata.arguments || {} })
        .then(() => bridge.sendToolResult(metadata.toolResult))
        .catch(() =>
          setStatus(
            "The app could not display this result. The saved snapshot is available below.",
          ),
        );
    };
    void bridge
      .connect(new PostMessageTransport(f.contentWindow!, f.contentWindow!))
      .then(() => {
        f.src = "/api/artifacts/" + artifactId + "/app";
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
