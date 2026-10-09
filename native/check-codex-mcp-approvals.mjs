// node native/check-codex-mcp-approvals.mjs <patched-hapi-root>
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(process.argv[2]);
const temp = await mkdtemp(join(tmpdir(), "loop-codex-approvals-"));
try {
  for (const [name, entry] of Object.entries({
    adapter: join(root, "cli/src/codex/utils/appServerPermissionAdapter.ts"),
    policy: new URL("../src/server/hapi/permission-policy.ts", import.meta.url)
      .pathname,
  })) {
    await build({
      entryPoints: [entry],
      outfile: join(temp, name + ".mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
      plugins: [
        {
          name: "fixture-logger",
          setup(b) {
            b.onResolve({ filter: /^@\/ui\/logger$/ }, () => ({
              path: "logger",
              namespace: "fixture",
            }));
            b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents: "export const logger = {debug(){}};",
            }));
          },
        },
      ],
    });
  }
  const { registerAppServerPermissionHandlers } = await import(
    pathToFileURL(join(temp, "adapter.mjs"))
  );
  const { hapiAutoApproval } = await import(
    pathToFileURL(join(temp, "policy.mjs"))
  );
  const handlers = new Map(),
    approvals = [],
    questions = [];
  registerAppServerPermissionHandlers({
    client: {
      registerRequestHandler: (name, handler) => handlers.set(name, handler),
    },
    shared: true,
    permissionHandler: {
      handleToolCall: async (_id, tool, input) => {
        approvals.push({ tool, arguments: input });
        return { decision: "approved" };
      },
    },
    onUserInputRequest: async (request) => {
      questions.push(request);
      return { decision: "cancel" };
    },
  });
  const handle = handlers.get("mcpServer/elicitation/request");
  const request = {
    threadId: "thread",
    serverName: "loop",
    mode: "form",
    message: 'Allow the loop MCP server to run tool "loop_read_file"?',
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      tool_params: { fileId: "file", offset: 16384 },
    },
    requestedSchema: { type: "object", properties: {} },
  };
  assert.deepEqual(await handle(request), {
    action: "accept",
    content: null,
    _meta: null,
  });
  assert.equal(approvals[0].tool, "loop"); // Codex may omit tool_name entirely.
  assert.equal(approvals[0].arguments.approvalKind, "mcp_tool_call");
  assert.equal(hapiAutoApproval("bypassPermissions", approvals[0]), true);
  assert.equal(hapiAutoApproval("default", approvals[0]), false);
  assert.equal(hapiAutoApproval("acceptEdits", approvals[0]), false);
  await handle({
    ...request,
    request: {
      ...request,
      _meta: { ...request._meta, tool_name: "loop_read_file" },
    },
  });
  assert.equal(approvals[1].tool, "loop_read_file");
  assert.equal(hapiAutoApproval("bypassPermissions", approvals[1]), true);
  // Metadata cannot turn an input form into a tool-only approval.
  await handle({
    ...request,
    requestedSchema: {
      type: "object",
      properties: { answer: { type: "string", title: "Choose a destination" } },
      required: ["answer"],
    },
  });
  assert.equal(approvals.length, 2);
  assert.equal(questions.length, 1);
  assert.equal(
    hapiAutoApproval("bypassPermissions", {
      tool: "request_user_input",
      arguments: questions[0].input,
    }),
    false,
  );
  await handle({ ...request, _meta: { codex_approval_kind: "unrecognized" } });
  assert.equal(approvals.length, 2);
  console.log(
    "Pinned Codex MCP approval classification passed; human input remains separate.",
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
