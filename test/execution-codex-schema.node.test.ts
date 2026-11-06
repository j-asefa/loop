import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { gitProject } from "./git-project.js";
import { agentModelName, runModelName } from "../src/client/modelChoices.js";
import type { Connection } from "../src/shared/types.js";

const directory = mkdtempSync(join(tmpdir(), "loop-codex-schema-"));
process.env.LOOP_DATA_DIR = join(directory, "data");
process.env.LOOP_TEST_HARNESS = "codex";
// Codex's generated v2 Config declares model: string | null.
process.env.LOOP_TEST_CODEX_NULL_MODEL = "1";
const { WorkspaceHost } = await import("../src/workspace-host.js");
const { db } = await import("../src/server/db.js");

test(
  "paired Codex registration, enablement and refresh preserve an unset native model",
  { timeout: 30_000 },
  async (t) => {
    const project = join(directory, "project");
    mkdirSync(project);
    gitProject(project);
    const options = {
      harness: "codex" as const,
      executable: resolve("test/harness.mjs"),
      project,
      version: "fixture",
      billing: "subscription" as const,
    };
    const host = new WorkspaceHost(directory, options);
    t.after(async () => {
      await host.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    });
    await host.start(options);
    const origin = host.origin;
    const paired = await fetch(origin + "/pair", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: new URLSearchParams(new URL(host.pair().url).hash.slice(1)).get(
          "pair",
        ),
        name: "Codex schema fixture",
      }),
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = await fetch(origin + "/session", {
      headers: { cookie },
    }).then((r) => r.json());
    const api = async (path: string, body?: object) => {
      const response = await fetch(origin + "/api" + path, {
        method: body ? "POST" : "GET",
        headers: {
          cookie,
          Origin: origin,
          "x-loop-csrf": csrf,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json();
      assert(
        response.ok,
        JSON.stringify({ path, status: response.status, data }),
      );
      return data;
    };
    const projectId = (await api("/workspace")).projectPaths[0].folder_id;
    const commandId = randomUUID();
    const input = { projectId, billing: "subscription", commandId };
    const enabled = await api("/workspace/runtimes/codex/enable", input);
    assert.equal(enabled.billing.model, null);
    assert.equal(enabled.billing.provider, "openai");
    assert.deepEqual(
      await api("/workspace/runtimes/codex/enable", input),
      enabled,
    );
    await api("/connections/native-codex/refresh", {});
    const { models } = await api("/connections/native-codex/models");
    assert.equal(
      models.find((model: { id: string }) => model.id === "native-default")
        ?.resolvedModel,
      "fixture-default-model",
    );
    const connections = (await api("/bootstrap")).connections as Connection[];
    assert.equal(
      agentModelName(
        { connection_id: "native-codex", model: "native-default" },
        connections,
      ),
      "fixture-default-model",
    );
    assert.equal(
      runModelName(
        { connectionId: "native-codex", model: "native-default" },
        connections,
      ),
      "fixture-default-model",
    );
    const receipts = db
      .prepare("SELECT method,state FROM execution_commands ORDER BY method")
      .all();
    assert.deepEqual(receipts, [
      { method: "runtime.enable", state: "completed" },
      { method: "runtime.register", state: "completed" },
    ]);
  },
);
