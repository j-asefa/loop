import { companionMode } from "../profile.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Problem } from "../domain.js";

/** Command-based MCP servers run only as children of the companion. */
export function assertLocalRuntime() {
  if (!companionMode)
    throw new Problem(
      409,
      "Command-based MCP servers run only in the companion app.",
    );
}

/** The SDK owns this child. No shell, container or public runtime listener. */
export class RuntimeTransport extends StdioClientTransport {
  constructor(config: {
    command: string;
    args: string[];
    env: Record<string, string>;
  }) {
    assertLocalRuntime();
    super({ ...config, stderr: "pipe" });
  }
  override async start() {
    await super.start();
    // Drain sensitive diagnostic output without persisting it.
    this.stderr?.on("data", () => {});
  }
}
