import { afterEach, expect, it, vi } from "vitest";
import { profileCapabilities } from "../src/shared/capabilities";
import { workspaceApi } from "../src/shared/workspace-api";
import { fleetOperationReason } from "../src/client/fleetCapabilities";

const peer = "peer:m_" + "1".repeat(64);
const gateway = profileCapabilities("companion");
it("allows declared file reads without granting multipart uploads or unrelated streams", () => {
  const capabilities = {
    ...gateway,
    fleet: {
      version: 1 as const,
      machineId: peer.slice(5),
      reads: [],
      actions: [],
      files: true,
      events: false,
    },
  };
  for (const contract of [
    workspaceApi.artifactFile,
    workspaceApi.objectFile,
    workspaceApi.agentTracesExport,
    workspaceApi.artifactDownload,
  ])
    expect(fleetOperationReason(peer, capabilities, contract)).toBeUndefined();
  expect(
    fleetOperationReason(peer, capabilities, workspaceApi.uploadCreate),
  ).toContain("does not allow");
  expect(
    fleetOperationReason(
      peer,
      {
        ...capabilities,
        fleet: { ...capabilities.fleet, actions: ["uploadCreate"] },
      },
      workspaceApi.uploadCreate,
    ),
  ).toBeUndefined();
  expect(
    fleetOperationReason(
      peer,
      { ...capabilities, fleet: { ...capabilities.fleet, files: false } },
      workspaceApi.objectFile,
    ),
  ).toContain("files are unavailable");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it.each(["", "docker:fixture"])(
  "recovers local and Docker startup capabilities after a transient failure (%s)",
  async (source) => {
    vi.resetModules();
    vi.useFakeTimers();
    const assign = vi.fn();
    vi.stubGlobal("location", {
      href: "https://gateway.example/",
      search: "",
      assign,
    });
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    const path = source
      ? `/api/agent-sources/${encodeURIComponent(source)}/capabilities`
      : "/api/capabilities";
    let attempts = 0;
    const fetcher = vi.fn(async (url: string) => {
      // Multiplexed sources first inspect their serving gateway. Fail only the
      // selected source so this still verifies its own bounded retry behavior.
      if (url === path && attempts++ === 0)
        return Response.json(
          { error: "Temporary startup failure" },
          { status: 503 },
        );
      return Response.json(gateway);
    });
    vi.stubGlobal("fetch", fetcher);
    const routing = await import("../src/client/sourceRouting");
    routing.setShellSource(source);
    const client = await import("../src/client/capabilities");
    const pending = client.loadCapabilities().then(
      () => "loaded",
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toBe("loaded");
    expect(client.capabilities).toEqual(gateway);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(
      source ? ["/api/capabilities", path, path] : [path, path],
    );
    expect(routing.executionSourceId()).toBe(source);
    expect(assign).not.toHaveBeenCalled();
  },
);
it("does not inherit a gateway's or another machine's permissions", () => {
  expect(
    fleetOperationReason(peer, gateway, workspaceApi.nativeAnswer),
  ).toContain("unavailable");
  const capable = {
    ...gateway,
    fleet: {
      version: 1 as const,
      machineId: peer.slice(5),
      reads: ["nativeDecisions"],
      actions: ["nativeAnswer"],
      files: false,
      events: false,
    },
  };
  expect(
    fleetOperationReason(peer, capable, workspaceApi.nativeAnswer),
  ).toBeUndefined();
  expect(fleetOperationReason(peer, capable, workspaceApi.approval)).toContain(
    "does not allow",
  );
  expect(
    fleetOperationReason(
      peer,
      {
        ...capable,
        fleet: { ...capable.fleet, machineId: "m_" + "2".repeat(64) },
      },
      workspaceApi.nativeAnswer,
    ),
  ).toContain("unavailable");
  expect(
    fleetOperationReason("docker:older", gateway, workspaceApi.nativeAnswer),
  ).toBeUndefined();
});

it.each(
  [peer, "docker:fixture"].flatMap((source) =>
    [true, false].map((multiplex) => ({ source, multiplex })),
  ),
)(
  "uses the serving gateway's event transport for $source with gateway multiplex=$multiplex",
  async ({ source, multiplex }) => {
    vi.resetModules();
    vi.stubGlobal("location", {
      href: "https://gateway.example/",
      search: "",
      assign: vi.fn(),
    });
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    const selectedCapabilities = { ...gateway, eventMultiplex: !multiplex };
    const fetcher = vi.fn(async (path: string) =>
      Response.json(
        path === "/api/capabilities"
          ? { ...gateway, eventMultiplex: multiplex }
          : selectedCapabilities,
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const routing = await import("../src/client/sourceRouting");
    routing.setShellSource(source);
    const client = await import("../src/client/capabilities");
    await client.loadCapabilities();
    expect(client.eventMultiplexing).toBe(multiplex);
    expect(client.capabilities).toEqual(selectedCapabilities);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/api/capabilities",
      `/api/agent-sources/${encodeURIComponent(source)}/capabilities`,
    ]);
    expect(routing.executionSourceId()).toBe(source);
  },
);

it("clears a previous multiplex capability when gateway authorization is lost", async () => {
  vi.resetModules();
  vi.stubGlobal("location", {
    href: "https://gateway.example/",
    search: "",
    assign: vi.fn(),
  });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  let authorized = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      authorized
        ? Response.json({ ...gateway, eventMultiplex: true })
        : Response.json({ error: "Gateway access revoked" }, { status: 403 }),
    ),
  );
  const routing = await import("../src/client/sourceRouting");
  routing.setShellSource(peer);
  const client = await import("../src/client/capabilities");
  await client.loadCapabilities();
  expect(client.eventMultiplexing).toBe(true);
  authorized = false;
  await expect(client.loadCapabilities()).rejects.toMatchObject({
    status: 403,
  });
  expect(client.eventMultiplexing).toBe(false);
  expect(routing.executionSourceId()).toBe(peer);
});

it.each([401, 403, 409, 503])(
  "keeps an unavailable peer selected and authenticates only at the gateway after HTTP %s",
  async (status) => {
    vi.resetModules();
    const assign = vi.fn();
    vi.stubGlobal("location", {
      href: "https://gateway.example/?source=" + encodeURIComponent(peer),
      search: "?source=" + encodeURIComponent(peer),
      assign,
    });
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    const fetcher = vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path === "/api/capabilities"
              ? { ...gateway, eventMultiplex: true }
              : path === "/api/auth/get-session"
                ? {
                    user: { id: "gateway-owner", name: "Local" },
                    mode: "single-user",
                  }
                : { error: "Fixture peer unavailable" },
          ),
          {
            status: path.startsWith("/api/agent-sources/") ? status : 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const routing = await import("../src/client/sourceRouting");
    routing.setShellSource(peer);
    const client = await import("../src/client/capabilities");
    await client.loadCapabilities();
    expect(client.eventMultiplexing).toBe(true);
    expect(client.capabilities.pairedDevices).toBe(true);
    expect(client.capabilities.fleet?.actions).toEqual([]);
    expect(routing.executionSourceId()).toBe(peer);
    expect(assign).not.toHaveBeenCalled();
    // A peer deep link still uses the local cookie; authSession is never proxied.
    const { createSessionCheck } = await import("../src/client/app/Session");
    vi.stubGlobal("history", { replaceState: vi.fn() });
    const setSession = vi.fn();
    await createSessionCheck({ setSession })();
    expect(setSession).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({ id: "gateway-owner" }),
      }),
    );
    expect(
      fetcher.mock.calls.some(
        ([path]) => path.includes("agent-sources/") && path.includes("auth/"),
      ),
    ).toBe(false);
  },
  15000,
);

it("distinguishes a read-only preview from permission to send its shared content", () => {
  const capabilities = {
    ...gateway,
    fleet: {
      version: 1 as const,
      machineId: peer.slice(5),
      reads: ["sharePreview", "routingPreview"],
      actions: [],
      files: false,
      events: false,
    },
  };
  expect(
    fleetOperationReason(peer, capabilities, workspaceApi.sharePreview),
  ).toBeUndefined();
  expect(
    fleetOperationReason(peer, capabilities, workspaceApi.routingPreview),
  ).toBeUndefined();
  expect(
    fleetOperationReason(peer, capabilities, workspaceApi.shareSend),
  ).toContain("does not allow");
  expect(
    fleetOperationReason(
      peer,
      {
        ...capabilities,
        fleet: { ...capabilities.fleet, reads: [], actions: ["sharePreview"] },
      },
      workspaceApi.sharePreview,
    ),
  ).toContain("does not allow");
});
