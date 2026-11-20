import { expect, it } from "vitest";
import { VmProviderError } from "../src/server/vm/provider.js";
import {
  createSailboxProvider,
  sailboxArgv,
  sailboxStatus,
} from "../src/server/vm/sailbox-provider.js";

// Fixture coverage: a scripted fetch stands in for the Sailboxes API, with
// request and response shapes taken from Sail's published OpenAPI document.
// No Sailbox is contacted.

type Call = {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
  redirect?: RequestRedirect;
};

function fake(answer: (call: Call) => Response | Promise<Response> | Error) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const raw = init?.body;
    const call: Call = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
      body:
        typeof raw === "string"
          ? JSON.parse(raw)
          : raw instanceof Uint8Array
            ? Buffer.from(raw).toString()
            : undefined,
    };
    calls.push(call);
    const result = await answer(call);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof globalThis.fetch;
  return {
    calls,
    provider: createSailboxProvider({ apiKey: "sail-secret", fetch }),
  };
}

const ok = (body: unknown) => Response.json(body);
const failure = (status: number, text = "nope") =>
  Response.json(
    { error: { message: text, type: "x", param: null, code: null } },
    { status },
  );

it("creates a private Sailbox with the operation's idempotency key", async () => {
  const { calls, provider } = fake(() =>
    ok({ sailbox_id: "sb_1", status: "running" }),
  );
  expect(
    await provider.create({
      idempotencyKey: "op-1",
      appId: "app_1",
      name: "loop-exp-abc",
      imageRef: "BASE_IMAGE_DEVBOX",
      limits: { vcpuCount: 4, memoryLimitGib: 16, diskLimitGib: 64 },
      autoSleepSeconds: 900,
      volumes: [{ volumeId: "vol_1", mountPath: "/mnt/loop-auth" }],
    }),
  ).toEqual({ remoteId: "sb_1", status: "running" });
  const [call] = calls;
  expect(call.method).toBe("POST");
  expect(call.url.href).toBe(
    "https://sailbox-api.sailresearch.com/v1/sailboxes",
  );
  expect(call.headers.get("authorization")).toBe("Bearer sail-secret");
  expect(call.headers.get("idempotency-key")).toBe("op-1");
  expect(call.body).toEqual({
    app_id: "app_1",
    name: "loop-exp-abc",
    image: { base: "BASE_IMAGE_DEVBOX" },
    visibility: "private",
    vcpu_count: 4,
    memory_limit_gib: 16,
    state_disk_limit_gib: 64,
    auto_sleep: { automatic: true, min_seconds_before_sleep: 900 },
    volume_mounts: [
      { volume_id: "vol_1", mount_path: "/mnt/loop-auth", read_only: false },
    ],
  });
  expect(JSON.stringify(call.body)).not.toContain("sail-secret");
});

it("reports a 4xx answer as refused and an unanswered or 5xx call as uncertain", async () => {
  const cases: [Response | Error, "refused" | "uncertain"][] = [
    [failure(402, "billing"), "refused"],
    [failure(409), "refused"],
    [failure(429), "refused"],
    [failure(501), "refused"],
    [failure(500), "uncertain"],
    [failure(503), "uncertain"],
    [new TypeError("fetch failed"), "uncertain"],
    [new Response("not json"), "uncertain"],
  ];
  for (const [answer, outcome] of cases) {
    const { provider } = fake(() => answer);
    const error = await provider
      .ensureApp("loop-experiments")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VmProviderError);
    expect((error as VmProviderError).outcome).toBe(outcome);
  }
  const { provider } = fake(() => failure(402, "Add a payment method"));
  await expect(provider.whoami()).rejects.toThrow("Add a payment method");
});

it("finds live Sailboxes by exact name across pages, and refuses to guess past its page limit", async () => {
  const { calls, provider } = fake(({ url }) =>
    url.searchParams.get("offset") === "0"
      ? ok({
          data: [
            { sailbox_id: "sb_1", name: "loop-exp-abc", status: "sleeping" },
            { sailbox_id: "sb_x", name: "loop-exp-abcd", status: "running" },
          ],
          has_more: true,
        })
      : ok({
          data: [
            { sailbox_id: "sb_2", name: "loop-exp-abc", status: "creating" },
          ],
          has_more: false,
        }),
  );
  expect(await provider.findByName("app_1", "loop-exp-abc")).toEqual([
    { remoteId: "sb_1", status: "sleeping" },
    { remoteId: "sb_2", status: "provisioning" },
  ]);
  expect(Object.fromEntries(calls[0].url.searchParams)).toMatchObject({
    app: "app_1",
    name: "loop-exp-abc",
    exclude_status: "terminated",
  });
  const endless = fake(() => ok({ data: [], has_more: true }));
  await expect(
    endless.provider.findByName("app_1", "loop-exp-abc"),
  ).rejects.toMatchObject({ outcome: "uncertain" });
});

it("treats a missing Sailbox as already terminated and as absent on get", async () => {
  const { provider } = fake(() => failure(404));
  await expect(provider.terminate("sb_1", "op-2")).resolves.toBeUndefined();
  expect(await provider.get("sb_1")).toBeNull();
});

it("maps Sail's open status set, keeping unrecognised values unknown", () => {
  expect(sailboxStatus("create_failed")).toBe("failed");
  expect(sailboxStatus("interrupted_restorable")).toBe("paused");
  expect(sailboxStatus("terminating")).toBe("terminating");
  expect(sailboxStatus("hibernating")).toBe("unknown");
  expect(sailboxStatus(undefined)).toBe("unknown");
});

it("refuses a resume Sail reports as no longer possible", async () => {
  const { provider } = fake(() =>
    ok({
      sailbox_id: "sb_1",
      status: "failed",
      resume_state: "terminal_unavailable",
    }),
  );
  await expect(provider.resume("sb_1", "op-3")).rejects.toMatchObject({
    outcome: "refused",
  });
});

it("stops reading a file once it passes the limit", async () => {
  const { provider } = fake(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(6));
            controller.enqueue(new Uint8Array(6));
            controller.close();
          },
        }),
      ),
  );
  await expect(provider.readFile("sb_1", "/workspace/a", 10)).rejects.toThrow(
    "larger than 10 bytes",
  );
});

it("sets the working directory without shell-parsing the command", () => {
  expect(sailboxArgv(["claude", "-p", "a; rm -rf /"], "/workspace")).toEqual([
    "/bin/sh",
    "-c",
    'cd -- "$1" || exit 127; shift; exec "$@"',
    "loop-exec",
    "/workspace",
    "claude",
    "-p",
    "a; rm -rf /",
  ]);
  expect(sailboxArgv(["ls"], undefined)).toEqual(["ls"]);
});

it("streams exec output, writes stdin at increasing offsets and reports the exit code", async () => {
  const encoder = new TextEncoder();
  let release!: () => void;
  const stdinDone = new Promise<void>((resolve) => (release = resolve));
  const { calls, provider } = fake(async (call) => {
    if (call.url.pathname.endsWith("/exec"))
      return new Response(
        new ReadableStream({
          async start(controller) {
            const send = (event: unknown) =>
              controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
            send({ type: "started", exec_request_id: "exec/1" });
            send({
              type: "stdout",
              data: Buffer.from("hello ").toString("base64"),
              seq: 1,
            });
            // An event split across chunks is still read whole.
            const line = JSON.stringify({
              type: "stderr",
              data: Buffer.from("warn").toString("base64"),
              seq: 1,
            });
            controller.enqueue(encoder.encode(line.slice(0, 10)));
            controller.enqueue(encoder.encode(line.slice(10) + "\n"));
            await stdinDone;
            send({ type: "heartbeat" });
            send({ type: "exit", status: "failed", return_code: 3 });
            controller.close();
          },
        }),
      );
    if (call.url.pathname.endsWith("/stdin")) {
      if (call.url.searchParams.get("eof") === "true") release();
      return ok({ accepted_through: 0 });
    }
    return ok({});
  });
  const handle = await provider.exec("sb_1", ["cat"], {
    cwd: "/workspace",
    env: { LOOP_TOOLS_URL: "https://brain.example/api/internal/tool-bridge/t" },
    openStdin: true,
  });
  const read = async (stream: NodeJS.ReadableStream) => {
    let text = "";
    for await (const chunk of stream) text += String(chunk);
    return text;
  };
  const output = Promise.all([read(handle.stdout), read(handle.stderr)]);
  await new Promise<void>((resolve, reject) =>
    handle.stdin.write("ab", (error) => (error ? reject(error) : resolve())),
  );
  await new Promise<void>((resolve) => handle.stdin.end("cde", resolve));
  expect(await handle.exit).toEqual({ exitCode: 3, signal: null });
  expect(await output).toEqual(["hello ", "warn"]);

  const start = calls[0];
  expect(start.body).toMatchObject({
    command: sailboxArgv(["cat"], "/workspace"),
    open_stdin: true,
    env: {
      LOOP_TOOLS_URL: "https://brain.example/api/internal/tool-bridge/t",
    },
  });
  const writes = calls
    .filter((call) => call.url.pathname.endsWith("/stdin"))
    .map((call) => ({
      id: call.url.searchParams.get("exec_request_id"),
      offset: call.url.searchParams.get("offset"),
      eof: call.url.searchParams.get("eof"),
      body: call.body,
    }));
  expect(writes).toEqual([
    { id: "exec/1", offset: "0", eof: null, body: "ab" },
    { id: "exec/1", offset: "2", eof: null, body: "cde" },
    { id: "exec/1", offset: "5", eof: "true", body: "" },
  ]);
});

it("resolves exit with no code when the event stream drops", async () => {
  const { provider } = fake(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ type: "started", exec_request_id: "e" }) +
                  "\n",
              ),
            );
            controller.error(new Error("connection reset"));
          },
        }),
      ),
  );
  const handle = await provider.exec("sb_1", ["sleep", "100"], {});
  expect(await handle.exit).toEqual({ exitCode: null, signal: null });
});

it("treats a listing it cannot read as uncertain, not as proof of absence", async () => {
  for (const page of [
    {},
    { data: [] },
    { data: "none", has_more: false },
    { data: [null], has_more: false },
    { data: [{ sailbox_id: "sb_1", status: "running" }], has_more: false },
  ]) {
    const { provider } = fake(() => ok(page));
    await expect(
      provider.findByName("app_1", "loop-exp-abc"),
    ).rejects.toMatchObject({ outcome: "uncertain" });
  }
});

it("stops reading exec events while nobody reads the output", async () => {
  let pulls = 0;
  const encoder = new TextEncoder();
  const chunk = Buffer.alloc(64 * 1024, 1).toString("base64");
  const { provider } = fake(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            controller.enqueue(
              encoder.encode(
                (pulls === 1
                  ? JSON.stringify({ type: "started", exec_request_id: "e" }) +
                    "\n"
                  : "") +
                  JSON.stringify({ type: "stdout", data: chunk, seq: pulls }) +
                  "\n",
              ),
            );
            if (pulls === 500) controller.close();
          },
        }),
      ),
  );
  const handle = await provider.exec("sb_1", ["yes"], {});
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(pulls).toBeLessThan(10);
  handle.stdout.resume();
  handle.stderr.resume();
  await handle.exit;
  expect(pulls).toBe(500);
});

it("waits for every full output stream before reading more events", async () => {
  let pulls = 0;
  const encoder = new TextEncoder();
  const chunk = Buffer.alloc(64 * 1024, 1).toString("base64");
  const { provider } = fake(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            // stdout and stderr fill within one chunk.
            controller.enqueue(
              encoder.encode(
                (pulls === 1
                  ? JSON.stringify({ type: "started", exec_request_id: "e" }) +
                    "\n"
                  : "") +
                  JSON.stringify({ type: "stdout", data: chunk, seq: pulls }) +
                  "\n" +
                  JSON.stringify({ type: "stderr", data: chunk, seq: pulls }) +
                  "\n",
              ),
            );
            if (pulls === 200) controller.close();
          },
        }),
      ),
  );
  const handle = await provider.exec("sb_1", ["yes"], {});
  // Only stderr is read; stdout stays full.
  handle.stderr.resume();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(pulls).toBeLessThan(10);
  handle.stdout.resume();
  await handle.exit;
  expect(pulls).toBe(200);
});

it("reports a VM that booted into failed with Sail's reason, and mounts volumes on a running VM", async () => {
  const { calls, provider } = fake((call) =>
    call.url.pathname.endsWith("/from_checkpoint")
      ? ok({
          sailbox_id: "sb_2",
          status: "create_failed",
          error_message: "no capacity",
        })
      : ok({}),
  );
  expect(
    await provider.createFromCheckpoint({
      idempotencyKey: "exp-1",
      checkpointId: "ckpt_1",
      name: "loop-exp-1",
    }),
  ).toEqual({
    remoteId: "sb_2",
    status: "failed",
    errorMessage: "no capacity",
  });
  await provider.mountVolume("sb_2", {
    volumeId: "vol_1",
    mountPath: "/mnt/loop-auth",
  });
  const mount = calls[1];
  expect(mount.method).toBe("PUT");
  expect(mount.url.pathname).toBe("/v1/sailboxes/sb_2/volume-mounts");
  expect(mount.body).toEqual({
    volume_id: "vol_1",
    mount_path: "/mnt/loop-auth",
    read_only: false,
  });
});

it("never follows a redirect with the API key", async () => {
  const { calls, provider } = fake(() => ok({ org_id: "org_1" }));
  await provider.whoami();
  expect(calls[0].redirect).toBe("error");
});

it("reports no exit code when an exec event could not be read", async () => {
  const encoder = new TextEncoder();
  const { provider } = fake(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const line of [
              JSON.stringify({ type: "started", exec_request_id: "e" }),
              "{not json",
              JSON.stringify({ type: "stdout", data: 7, seq: 2 }),
              JSON.stringify({ type: "progress", note: "new event kind" }),
              JSON.stringify({
                type: "exit",
                status: "succeeded",
                return_code: 0,
              }),
            ])
              controller.enqueue(encoder.encode(line + "\n"));
            controller.close();
          },
        }),
      ),
  );
  const handle = await provider.exec("sb_1", ["true"], {});
  handle.stdout.resume();
  handle.stderr.resume();
  expect(await handle.exit).toEqual({ exitCode: null, signal: null });

  // An event type Loop does not know is not corruption.
  const clean = fake(
    () =>
      new Response(
        [
          JSON.stringify({ type: "started", exec_request_id: "e" }),
          JSON.stringify({ type: "progress" }),
          JSON.stringify({ type: "exit", status: "succeeded", return_code: 0 }),
        ].join("\n") + "\n",
      ),
  );
  const ok2 = await clean.provider.exec("sb_1", ["true"], {});
  ok2.stdout.resume();
  ok2.stderr.resume();
  expect(await ok2.exit).toEqual({ exitCode: 0, signal: null });
});
