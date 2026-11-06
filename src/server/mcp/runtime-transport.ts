import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** The SDK owns this child. No shell, container or public runtime listener. */
export class RuntimeTransport extends StdioClientTransport {
  constructor(config: {
    command: string;
    args: string[];
    env: Record<string, string>;
  }) {
    super({ ...config, stderr: "pipe" });
  }
  override async start() {
    await super.start();
    // Drain sensitive diagnostic output without persisting it.
    this.stderr?.on("data", () => {});
  }
}
