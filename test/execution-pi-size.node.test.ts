import { inProcessExecution } from "./in-process-execution.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gitProject } from "./git-project.js";
import { until } from "./helpers.js";

const directory = mkdtempSync(join(tmpdir(), "loop-execution-size-"));
process.env.LOOP_DATA_DIR = join(directory, "data");
process.env.LOOP_TEST_HARNESS = "claude";
process.env.PI_CODING_AGENT_DIR = join(directory, "pi");
mkdirSync(process.env.PI_CODING_AGENT_DIR);
const { WorkspaceHost } = await import("../src/workspace-host.js");
const { db } = await import("../src/server/db.js");
const { executionAuthority } =
  await import("../src/server/execution-authority.js");
const { setExecutionTransport } =
  await import("../src/server/execution-client.js");

test(
  "paired Pi preserves large API data and native controls through the execution boundary",
  { timeout: 60_000 },
  async (t) => {
    const project = join(directory, "project");
    mkdirSync(project);
    gitProject(project);
    const options = {
      harness: "claude" as const,
      executable: resolve("test/harness.mjs"),
      project,
      version: "fixture",
      billing: "existing" as const,
    };
    const host = new WorkspaceHost(directory, options, inProcessExecution);
    t.after(async () => {
      await host.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    });
    await host.start(options);
    const origin = host.origin;
    const pair = await fetch(origin + "/pair", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: new URLSearchParams(new URL(host.pair().url).hash.slice(1)).get(
          "pair",
        ),
        name: "size fixture",
      }),
    });
    assert.equal(pair.status, 200);
    const cookie = pair.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = await fetch(origin + "/session", {
      headers: { cookie },
    }).then((r) => r.json());
    const api = async (path: string, body?: object, method?: string) => {
      const response = await fetch(origin + "/api" + path, {
        method: method || (body ? "POST" : "GET"),
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
    // Existing native registration, with no provider login or package process.
    db.prepare(
      "INSERT INTO harnesses SELECT 'pi',?,billing,capabilities,models,updated_at FROM harnesses WHERE name='claude'",
    ).run(JSON.stringify({ ...options, harness: "pi" }));
    db.prepare(
      "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) SELECT 'native-pi',owner_id,'pi','Pi','',status,models,?,created_at FROM connections WHERE id='native-claude'",
    ).run(
      JSON.stringify({
        loopHarness: "pi",
        authMode: "native-existing",
        runtimeKind: "loop-local",
      }),
    );
    const agent = await api("/agents", {
      name: "pi-size-fixture",
      connectionId: "native-pi",
      model: "native-default",
      folderId: projectId,
      instructions: "Fixture",
    });
    const base = `/agents/${agent.id}`;
    const settings = join(process.env.PI_CODING_AGENT_DIR!, "settings.json");
    const filters = Object.fromEntries(
      ["extensions", "skills", "prompts", "themes"].map((kind) => [
        kind,
        Array.from({ length: 100 }, () => "😀".repeat(150)),
      ]),
    );
    const hash = () =>
      createHash("sha256").update(readFileSync(settings)).digest("hex");
    let largestReply = 0;
    const methods: string[] = [];
    setExecutionTransport({
      status: () => executionAuthority.status(),
      send: async (message) => {
        methods.push(message.method);
        const reply = await executionAuthority.request(message);
        largestReply = Math.max(
          largestReply,
          Buffer.byteLength(JSON.stringify(reply)),
        );
        return reply;
      },
    });

    await t.test(
      "a schema-valid Unicode filter request above 128 KiB succeeds",
      async () => {
        writeFileSync(settings, JSON.stringify({ packages: ["npm:fixture"] }));
        const input = {
          source: "npm:fixture",
          scope: "user",
          filters,
          settingsHash: hash(),
        };
        assert(Buffer.byteLength(JSON.stringify(input)) > 128 * 1024);
        const result = await api(base + "/pi-package-filters", input);
        assert.equal(result.status, "configured");
        assert.deepEqual(result.packages[0].filters, filters);
      },
    );
    await t.test(
      "a configuration above 2 MiB remains readable after a successful bounded mutation",
      async () => {
        writeFileSync(
          settings,
          JSON.stringify({
            packages: Array.from({ length: 12 }, (_, i) => ({
              source: "npm:fixture-" + i,
              ...filters,
            })),
          }),
        );
        const input = {
          source: "npm:fixture-0",
          scope: "user",
          filters: { themes: ["chosen"] },
          settingsHash: hash(),
        };
        const result = await api(base + "/pi-package-filters", input);
        assert.equal(result.status, "configured");
        assert(Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024);
        assert.deepEqual(result.packages[0].filters, input.filters);
        const config = await api(base + "/pi-packages");
        assert.deepEqual(config.packages, result.packages);
        const trusted = await api(base + "/pi-trust", {
          trusted: true,
          fingerprint: config.trust.fingerprint,
        });
        assert.equal(trusted.packages.length, 12);
        assert.equal(trusted.trust.trusted, true);
        assert(largestReply < 1024, String(largestReply));
        assert(!methods.includes("pi.configuration"));
        const receipts = db
          .prepare(
            "SELECT state,result FROM execution_commands WHERE method LIKE 'pi.%'",
          )
          .all() as { state: string; result: string }[];
        assert.equal(receipts.length, 3);
        assert(
          receipts.every(
            (row) => row.state === "completed" && row.result.length < 100,
          ),
        );
      },
    );
    process.env.LOOP_TEST_HARNESS = "pi";
    process.env.LOOP_TEST_PI_MODEL_COUNT = "150";
    process.env.LOOP_TEST_PI_LONG_MODEL_ID = "1";
    process.env.LOOP_TEST_PI_COMMAND_METADATA = "1";
    process.env.LOOP_TEST_PI_MODEL_AUDIT = join(directory, "model-audit");
    await t.test(
      "runtime enablement preserves complete native model identifiers",
      async () => {
        const { models } = await api("/workspace/runtimes/pi/enable", {
          projectId,
          billing: "existing",
          commandId: randomUUID(),
        });
        assert(
          models.some(
            (model: { id: string }) =>
              model.id === "openai-codex/custom-" + "x".repeat(250),
          ),
        );
      },
    );
    await t.test(
      "the new-chat model catalog returns every native model up to the registration bound",
      async () => {
        process.env.LOOP_TEST_PI_MODEL_COUNT = "354";
        try {
          const { models } = await api("/connections/native-pi/models");
          assert.equal(models.length, 357);
          assert(
            models.some(
              (model: { id: string }) =>
                model.id === "openai-codex/custom-" + "x".repeat(250),
            ),
          );
          process.env.LOOP_TEST_PI_MODEL_COUNT = "5000";
          const refused = await fetch(
            origin + "/api/connections/native-pi/models",
            { headers: { cookie, Origin: origin, "x-loop-csrf": csrf } },
          );
          assert.equal(refused.status, 422);
          assert.match(
            (await refused.json()).error,
            /reported 5003 models; Loop accepts up to 5000/,
          );
          const stored = db
            .prepare("SELECT models FROM connections WHERE id='native-pi'")
            .get() as { models: string };
          assert.equal(JSON.parse(stored.models).length, 357);
        } finally {
          process.env.LOOP_TEST_PI_MODEL_COUNT = "150";
          await api("/connections/native-pi/models");
        }
      },
    );
    const run = await api("/runs", {
      agentId: agent.id,
      input: "fixture",
      idempotencyKey: randomUUID(),
    });
    await until(
      () =>
        (
          db.prepare("SELECT state FROM runs WHERE id=?").get(run.id) as {
            state: string;
          }
        ).state === "completed",
    );
    await t.test(
      "complete model choices and labels survive control reads and an idempotent setting write",
      async () => {
        const path = `/conversations/${run.conversation_id}/settings`;
        const controls = await api(path);
        const model = controls.settings.options.find(
          (option: { id: string }) => option.id === "model",
        );
        assert.equal(model.choices.length, 152);
        assert(
          model.choices.some(
            (choice: { label: string }) => choice.label.length > 500,
          ),
        );
        const input = {
          value: "openai-codex/model-149",
          revision: controls.settings.revision,
          generation: controls.generation,
          commandId: randomUUID(),
        };
        const changed = await api(path + "/model", input, "PATCH");
        assert.equal(
          changed.settings.options.find(
            (option: { id: string }) => option.id === "model",
          ).confirmed,
          input.value,
        );
        assert.deepEqual(await api(path + "/model", input, "PATCH"), changed);
        assert.equal(
          readFileSync(process.env.LOOP_TEST_PI_MODEL_AUDIT!, "utf8"),
          "model-149\n",
        );
        assert.equal(
          (
            db
              .prepare(
                "SELECT state FROM execution_commands WHERE command_id=?",
              )
              .get(input.commandId) as { state: string }
          ).state,
          "completed",
        );
      },
    );
    await t.test(
      "native command source metadata remains extensible",
      async () => {
        const catalog = await api(
          base + "/harness?conversation=" + run.conversation_id,
        );
        assert.equal(
          catalog.commands.find(
            (command: { name: string }) => command.name === "fixture-command",
          ).sourceInfo.packageId,
          "fixture-package",
        );
      },
    );
    await t.test(
      "native catalogs between 2 and 8 MiB retain all commands",
      async () => {
        process.env.LOOP_TEST_PI_LARGE_CATALOG = "1";
        process.env.LOOP_TEST_PI_SESSION_ID = randomUUID();
        const turn = await api("/runs", {
          agentId: agent.id,
          input: "fixture",
          idempotencyKey: randomUUID(),
        });
        await until(() =>
          ["completed", "failed"].includes(
            (
              db.prepare("SELECT state FROM runs WHERE id=?").get(turn.id) as {
                state: string;
              }
            ).state,
          ),
        );
        const row = db
          .prepare("SELECT state,error FROM runs WHERE id=?")
          .get(turn.id) as { state: string; error: string };
        assert.equal(row.state, "completed", JSON.stringify(row));
        const catalog = await api(
          `${base}/harness?conversation=${turn.conversation_id}`,
        );
        assert.equal(catalog.commands.length, 120);
        assert.equal(catalog.commands[119].description.length, 30_000);
        assert(Buffer.byteLength(JSON.stringify(catalog)) > 2 * 1024 * 1024);
        const controls = await api(
          `/conversations/${turn.conversation_id}/settings`,
        );
        assert.equal(controls.commands.commands.length, 120);
      },
    );
  },
);
