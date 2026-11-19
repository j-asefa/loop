import { seedAgent, seedConnection } from "./helpers/seed.js";
import { testDirectory } from "./helpers/test-workspace.js";
import type { RunPayload } from "../src/shared/run-payload";
import { gitProject } from "./helpers/git-project.js";
import { afterAll, expect, it, vi } from "vitest";
import { chmodSync, realpathSync } from "node:fs";

import { join, resolve } from "node:path";

const dir = realpathSync(testDirectory());

gitProject(dir);
process.env.LOOP_TEST_HARNESS = "claude";
process.env.LOOP_TEST_ARGV = join(dir, "argv.jsonl");
const { db } = await import("../src/server/db");
seedAgent(db, {
  id: "worktree-fixture",
  owner_id: "local-workspace",
  name: "Fixture",
  normalized_name: "fixture",
  provider: "codex",
  model: "fixture",
  created_at: 0,
});
const { enqueue } = await import("../src/server/queue");
const { NativeSessions } = await import("../src/server/native-sessions");
const { OWNER } = await import("../src/server/workspace-identity");
const executable = resolve("test/fixtures/harness.mjs");
chmodSync(executable, 0o755);
db.prepare("INSERT INTO harnesses VALUES('claude',?,'{}','{}','[]',0)").run(
  JSON.stringify({
    harness: "claude",
    executable,
    project: dir,
    billing: "existing",
    version: "fixture",
  }),
);
seedConnection(db, {
  id: "native-claude",
  owner_id: OWNER,
  provider: "anthropic",
  label: "Claude",
  secret: "",
  models: "[]",
  metadata: JSON.stringify({ loopHarness: "claude" }),
  created_at: 0,
});
afterAll(() => {
  db.close();

  delete process.env.LOOP_TEST_HARNESS;
  delete process.env.LOOP_TEST_ARGV;
});
function run(
  name: string,
  permissionMode: RunPayload["permissionMode"] = "default",
  conversation = name,
) {
  db.prepare(
    "INSERT OR IGNORE INTO conversations(id,owner_id,title,created_at) VALUES(?,?,'Test',0)",
  ).run(conversation, OWNER);
  return enqueue(OWNER, "Fixture only", name, {
    conversation,
    agent: "worktree-fixture",
    payload: {
      agentId: "worktree-fixture",
      name: "Fixture",
      provider: "anthropic",
      folderId: null,
      connectionId: "native-claude",
      model: "native-default",
      instructions: "",
      permissionMode,
    },
  });
}

it.each([false, true])(
  "waits for capacity without premature baseline or permission mutations (cancel=%s)",
  async (cancel) => {
    const { MAX_CONCURRENT_RUNS } =
      await import("../src/shared/concurrency.js");
    const { transition } = await import("../src/server/queue.js");
    const { tick } = await import("../src/server/worker.js");
    const { execFileSync } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    const sessions = new NativeSessions();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controls: Promise<unknown>[] = [];
    const mocks: Array<{ mockRestore(): void }> = [];
    let work: Promise<boolean> | undefined;
    let entered = 0;
    try {
      const prefix = cancel ? "cancel-" : "complete-";
      const saved = run(prefix + "saved");
      const initial = await sessions.session(saved);
      if (!cancel) {
        const { NativeSessionCurrency } =
          await import("../src/server/native/currency.js");
        type Check =
          import("../src/server/native/currency.js").NativeCurrencyCheck;
        type Kind = Check["kind"];
        const kinds: Kind[] = [
          "event",
          "dispose-entry",
          "decision-wait",
          "bridge-turn",
          "output-flush",
          "session-access",
          "settings",
          "settings-dispatch",
          "input-dispatch",
          "decision-admission",
          "answer-dispatch",
          "decision-reopen",
          "stored-projection",
          "harness-switch",
          "usage",
          "session-preparation",
        ];
        const trials: [string, Kind[]][] = [
          ["baseline", []],
          [
            "replaced map",
            [
              "event",
              "dispose-entry",
              "decision-wait",
              "output-flush",
              "settings",
              "settings-dispatch",
              "input-dispatch",
              "answer-dispatch",
              "decision-reopen",
              "session-preparation",
            ],
          ],
          [
            "closed",
            [
              "event",
              "decision-wait",
              "output-flush",
              "session-access",
              "settings",
              "settings-dispatch",
              "input-dispatch",
              "decision-admission",
              "answer-dispatch",
              "decision-reopen",
              "session-preparation",
            ],
          ],
          [
            "cancelling",
            ["settings-dispatch", "input-dispatch", "answer-dispatch"],
          ],
          [
            "live generation",
            [
              "session-access",
              "settings",
              "settings-dispatch",
              "input-dispatch",
              "decision-admission",
              "answer-dispatch",
              "decision-reopen",
              "usage",
            ],
          ],
          [
            "different run id",
            [
              "decision-wait",
              "bridge-turn",
              "output-flush",
              "settings-dispatch",
              "input-dispatch",
              "decision-admission",
              "answer-dispatch",
              "decision-reopen",
            ],
          ],
          ["different run object", ["output-flush", "settings-dispatch"]],
          [
            "no run",
            [
              "decision-wait",
              "bridge-turn",
              "output-flush",
              "session-access",
              "settings-dispatch",
              "input-dispatch",
              "decision-admission",
              "answer-dispatch",
              "decision-reopen",
              "usage",
            ],
          ],
          [
            "wrong conversation",
            ["output-flush", "settings-dispatch", "usage"],
          ],
          [
            "stored generation",
            [
              "settings",
              "settings-dispatch",
              "stored-projection",
              "harness-switch",
              "usage",
            ],
          ],
          [
            "null stored generation",
            [
              "settings",
              "settings-dispatch",
              "stored-projection",
              "harness-switch",
              "usage",
            ],
          ],
          [
            "missing stored generation",
            [
              "settings",
              "settings-dispatch",
              "stored-projection",
              "harness-switch",
              "usage",
            ],
          ],
          [
            "terminal run",
            [
              "input-dispatch",
              "decision-admission",
              "answer-dispatch",
              "decision-reopen",
              "session-preparation",
            ],
          ],
          ["receipt state", ["answer-dispatch"]],
          ["receipt command", ["answer-dispatch"]],
          ["receipt digest", ["answer-dispatch"]],
          ["missing receipt", ["answer-dispatch"]],
          ["decision state", ["decision-admission"]],
          ["not waiting", ["settings-dispatch"]],
          ["model setting", ["settings-dispatch"]],
          ...(
            [
              "generation",
              "harness",
              "project",
              "worktree_agent_id",
              "worktree_source",
            ] as const
          ).map((field): [string, Kind[]] => [
            "binding " + field,
            ["session-preparation"],
          ]),
          ["missing binding", ["session-preparation"]],
        ];
        for (const [trial, denied] of trials) {
          const live = { ...initial, run: saved, waiting: true };
          const map = new Map([[saved.conversation_id!, live]]);
          const guard = new NativeSessionCurrency(map);
          const generation = live.generation;
          let storedGeneration: string | null | undefined = generation;
          let state = "running";
          let receipt:
            { state: string; command_id: string; digest: string } | undefined =
            { state: "deciding", command_id: "command", digest: "digest" };
          const before = { ...live.binding };
          let latest: typeof before | undefined = { ...before };
          if (trial === "replaced map")
            map.set(saved.conversation_id!, { ...live });
          if (trial === "closed") live.closed = true;
          if (trial === "cancelling") live.cancelling = true;
          if (trial === "live generation") live.generation = "replacement";
          if (trial === "different run id")
            live.run = { ...saved, id: "replacement" };
          if (trial === "different run object") live.run = { ...saved };
          if (trial === "no run") delete (live as { run?: typeof saved }).run;
          if (trial === "wrong conversation")
            live.run = { ...saved, conversation_id: "other" };
          if (trial === "stored generation") storedGeneration = "replacement";
          if (trial === "null stored generation") storedGeneration = null;
          if (trial === "missing stored generation")
            storedGeneration = undefined;
          if (trial === "terminal run") state = "cancelled";
          if (trial === "receipt state") receipt!.state = "unknown";
          if (trial === "receipt command") receipt!.command_id = "other";
          if (trial === "receipt digest") receipt!.digest = "other";
          if (trial === "missing receipt") receipt = undefined;
          if (trial === "not waiting") live.waiting = false;
          if (trial.startsWith("binding "))
            Object.assign(latest!, { [trial.slice(8)]: "changed" });
          if (trial === "missing binding") latest = undefined;
          const turn = { live, generation, runId: saved.id };
          const checks: Record<Kind, Check> = {
            event: { kind: "event", live },
            "dispose-entry": { kind: "dispose-entry", live },
            "decision-wait": { kind: "decision-wait", live, runId: saved.id },
            "bridge-turn": { kind: "bridge-turn", live, runId: saved.id },
            "output-flush": { kind: "output-flush", live, run: saved },
            "session-access": {
              kind: "session-access",
              live,
              generation,
              requireRun: true,
            },
            settings: {
              kind: "settings",
              conversation: saved.conversation_id!,
              live,
              generation,
              storedGeneration,
            },
            "settings-dispatch": {
              kind: "settings-dispatch",
              conversation: saved.conversation_id!,
              live,
              generation,
              storedGeneration,
              run: saved,
              setting: trial === "model setting" ? "model" : "mode",
            },
            "input-dispatch": {
              kind: "input-dispatch",
              ...turn,
              state: () => state,
            },
            "decision-admission": {
              kind: "decision-admission",
              ...turn,
              state,
              decisionState:
                trial === "decision state" ? "resolved" : "pending",
            },
            "answer-dispatch": {
              kind: "answer-dispatch",
              ...turn,
              receipt,
              commandId: "command",
              digest: "digest",
              state: () => state,
            },
            "decision-reopen": { kind: "decision-reopen", ...turn, state },
            "stored-projection": {
              kind: "stored-projection",
              storedGeneration,
              generation,
            },
            "harness-switch": {
              kind: "harness-switch",
              storedGeneration,
              generation,
            },
            usage: { kind: "usage", live, storedGeneration },
            "session-preparation": {
              kind: "session-preparation",
              conversation: saved.conversation_id!,
              live,
              before,
              latest,
              state: "running",
              currentState: () => state,
            },
          };
          for (const kind of kinds)
            expect(guard.allows(checks[kind]), trial + ": " + kind).toBe(
              !denied.includes(kind),
            );
          if (trial === "no run")
            expect(
              guard.allows({
                kind: "session-access",
                live,
                generation,
                requireRun: false,
              }),
            ).toBe(true);
        }
        const empty = new NativeSessionCurrency(new Map());
        expect(
          empty.allows({
            kind: "session-access",
            live: undefined,
            generation: "missing",
            requireRun: false,
          }),
        ).toBe(false);
        expect(
          empty.allows({
            kind: "session-preparation",
            conversation: "missing",
            live: undefined,
            before: undefined,
            latest: undefined,
            state: "running",
            currentState: () => "running",
          }),
        ).toBe(true);
      }
      await sessions.setSetting(
        saved.conversation_id!,
        "mode",
        "auto",
        initial.adapter.settings!.revision,
        initial.generation,
      );
      await sessions.dispose(initial);
      let checkout = "";
      for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) {
        const live = await sessions.session(
          run(prefix + "capacity-worker-" + i),
        );
        checkout = live.binding.project;
        mocks.push(
          vi.spyOn(live.adapter, "setSetting").mockImplementation(async () => {
            entered++;
            await gate;
            throw new Error("Fixture setting finished");
          }),
        );
        controls.push(
          sessions
            .setSetting(
              live.binding.conversation_id,
              "mode",
              "auto",
              1,
              live.generation,
            )
            .catch((error: unknown) => error),
        );
      }
      // These fixtures created idle native contexts, not worker turns.
      const queued = db
        .prepare("SELECT * FROM runs WHERE state='queued'")
        .all() as Array<Parameters<typeof transition>[0]>;
      for (const task of queued) transition(task, "cancelled");
      await vi.waitFor(() => expect(entered).toBe(MAX_CONCURRENT_RUNS));
      const extra = run(
        prefix + "capacity-worker-new",
        "acceptEdits",
        saved.conversation_id!,
      );
      let claims = 0;
      let settled = false;
      work = tick(async (claimed) => {
        expect(claimed.id).toBe(extra.id);
        claims++;
        return sessions.execute(claimed);
      }).finally(() => {
        settled = true;
      });
      await vi.waitFor(() =>
        expect(
          db
            .prepare("SELECT 1 FROM companion_sessions WHERE conversation_id=?")
            .get(extra.conversation_id),
        ).toBeDefined(),
      );
      const waiting = await Promise.race([
        work.then(() => false),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(true), 1500),
        ),
      ]);
      expect({
        waiting,
        settled,
        run: db.prepare("SELECT state FROM runs WHERE id=?").get(extra.id),
        checkout: db
          .prepare("SELECT 1 FROM run_checkouts WHERE run_id=?")
          .get(extra.id),
      }).toEqual({
        waiting: true,
        settled: false,
        run: { state: "running" },
        checkout: undefined,
      });
      expect(
        db.prepare("SELECT 1 FROM run_checkouts WHERE run_id=?").get(extra.id),
      ).toBeUndefined();
      expect(sessions.count).toBe(MAX_CONCURRENT_RUNS);
      if (cancel) {
        transition(extra, "cancelled");
        expect(await work).toBe(true);
        expect(claims).toBe(1);
        expect(
          db
            .prepare(
              "SELECT permission_mode,permission_base FROM companion_sessions WHERE conversation_id=?",
            )
            .get(saved.conversation_id),
        ).toEqual({ permission_mode: "auto", permission_base: "default" });
        release();
        await Promise.all(controls);
        const next = await sessions.session(
          run(prefix + "followup", "default", saved.conversation_id!),
        );
        expect(next.sessionMode).toBe("auto");
        expect(
          next.adapter.settings!.options.find((option) => option.id === "mode"),
        ).toMatchObject({ confirmed: "auto" });
        return;
      }
      writeFileSync(
        join(checkout, "tracked.txt"),
        "Changed while waiting for capacity",
      );
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", checkout, ...args], {
          encoding: "utf8",
        }).trim();
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "commit",
        "-am",
        "change before native startup",
      );
      const expectedHead = git("rev-parse", "HEAD");
      release();
      await Promise.all(controls);
      expect(await work).toBe(true);
      expect(claims).toBe(1);
      expect(
        db
          .prepare(
            "SELECT permission_mode,permission_base FROM companion_sessions WHERE conversation_id=?",
          )
          .get(saved.conversation_id),
      ).toEqual({ permission_mode: null, permission_base: null });
      expect(
        db.prepare("SELECT state FROM runs WHERE id=?").get(extra.id),
      ).toEqual({ state: "completed" });
      expect(
        db
          .prepare("SELECT start_head FROM run_checkouts WHERE run_id=?")
          .get(extra.id),
      ).toEqual({ start_head: expectedHead });
      expect(sessions.count).toBe(MAX_CONCURRENT_RUNS);
    } finally {
      release();
      await Promise.allSettled([...controls, work]);
      for (const mock of mocks) mock.mockRestore();
      await sessions.close();
    }
  },
  30000,
);

it.each(["running", "cancelled"] as const)(
  "settles completed native turns after a concurrent %s decision",
  async (next) => {
    const { transition, claim } = await import("../src/server/queue.js");
    const queries = await import("../src/server/sql/runs.js");
    const { applyRunOutcome } = await import("../src/server/worker.js");
    const sessions = new NativeSessions();
    const task = run("native-completion-race-" + next);
    const live = await sessions.session(task);
    let finishing = false;
    const read = queries.ownedState;
    const spy = vi
      .spyOn(queries, "ownedState")
      .mockImplementation((...args) => {
        const row = read(...args);
        if (
          args[1] === task.id &&
          finishing &&
          row?.state === "awaiting_approval"
        ) {
          finishing = false;
          expect(transition(task, next)).toBe(true);
        }
        return row;
      });
    const prompt = vi
      .spyOn(live.adapter, "prompt")
      .mockImplementation(async () => {
        expect(transition(task, "awaiting_approval")).toBe(true);
        finishing = true;
        live.finish!("completed");
      });
    try {
      const claimed = claim(
        "completion-race",
        (candidate) => candidate.id === task.id,
      )!;
      expect(claimed.id).toBe(task.id);
      const complete = await sessions.execute(claimed);
      applyRunOutcome(claimed, "completion-race", complete);
      expect(finishing).toBe(false);
      expect(
        db.prepare("SELECT state FROM runs WHERE id=?").get(task.id),
      ).toEqual({ state: next === "running" ? "completed" : "cancelled" });
    } finally {
      spy.mockRestore();
      prompt.mockRestore();
      await sessions.dispose(live);
    }
  },
);
