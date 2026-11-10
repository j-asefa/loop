import { Native } from "./native.js";

export async function museHost(
  executable: string,
  project: string,
  env?: NodeJS.ProcessEnv,
) {
  const native = new Native(executable, ["serve"], project, env);
  native.jsonrpc = true;
  try {
    // Account and login methods are on Muse's experimental surface.
    const init = await native.request("initialize", {
      clientInfo: { name: "loop", title: "Loop", version: "0.1.0" },
      // Loop's workspace tools are added per session as an MCP server.
      capabilities: {
        experimentalApi: true,
        requestedCapabilities: ["sessionMcp"],
      },
    });
    await native.write({ method: "initialized" });
    return {
      native,
      granted: new Set<string>(
        Array.isArray(init?.grantedCapabilities)
          ? init.grantedCapabilities
          : [],
      ),
    };
  } catch (error) {
    await native.dispose();
    throw error;
  }
}
