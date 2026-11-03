import { expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { gitProject } from "./git-project";

it.each(["companion", "server"])(
  "%s rejects unsupported team connection edits, submissions and persisted dispatches",
  async (profile) => {
    vi.resetModules();
    const dir = mkdtempSync(join(tmpdir(), "loop-agy-team-"));
    process.env.LOOP_DATA_DIR = join(dir, "data");
    process.env.LOOP_PROFILE = profile;
    gitProject(dir);
    writeFileSync(join(dir, "review.ts"), "export const reviewed = true;\n");
    const { db, id } = await import("../src/server/db");
    const { core } = await import("../src/server/core-routes");
    const { createAgent, ownedAgent, ownedRun } =
      await import("../src/server/domain");
    const { createTeam, createPresetTeam, deleteTeam } =
      await import("../src/server/teams");
    const { submit, executeAgent } =
      await import("../src/server/agent-runtime");
    const { startCodeReview } = await import("../src/server/code-reviews");
    const { nativeSessions } = await import("../src/server/native-sessions");
    const app = express();
    app.use(
      express.json(),
      (req, res, next) => {
        res.locals.owner = req.get("x-owner") || "alice";
        next();
      },
      core,
    );
    app.use((error: any, _req: any, res: any, _next: any) =>
      res.status(error.status || 500).json({ error: error.message }),
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    const patch = async (agentId: string, owner = "alice") => {
      const response = await fetch(url + "/agents/" + agentId, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-owner": owner },
        body: JSON.stringify({
          connectionId: "agy",
          model: "fixture",
          instructions: "New instructions",
        }),
      });
      return { status: response.status, data: await response.json() };
    };
    try {
      for (const [connectionId, provider, metadata] of [
        ["api", "openai", {}],
        [
          "agy",
          "antigravity",
          {
            loopHarness: "antigravity",
            authMode: "native-existing",
            capabilities: { workspaceTools: false },
          },
        ],
      ] as const)
        db.prepare(
          "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,'alice',?,'Fixture','','connected',?,?,0)",
        ).run(
          connectionId,
          provider,
          JSON.stringify([{ id: "fixture", name: "Fixture" }]),
          JSON.stringify(metadata),
        );
      const agent = (name: string) =>
        createAgent("alice", { name, connectionId: "api", model: "fixture" });
      const manager = agent("manager"),
        worker = agent("worker"),
        personal = agent("personal");
      const team = createTeam("alice", {
        name: "Team",
        managerId: manager.id,
        members: [worker.id],
      });
      for (const member of [manager, worker]) {
        expect((await patch(member.id, "bob")).status).toBe(404);
        const denied = await patch(member.id);
        expect(denied.status).toBe(409);
        expect(denied.data.error).toMatch(/workspace tools/);
        expect(ownedAgent(member.id, "alice")).toEqual(member);
      }
      expect((await patch(personal.id)).status).toBe(200);
      expect(ownedAgent(personal.id, "alice").connection_id).toBe("agy");

      // A queued legacy snapshot must be rejected again at execution, before
      // calling any native harness, even if it predates the admission guard.
      const queued = submit("alice", {
        agentId: worker.id,
        teamId: team.id,
        input: "Team task",
        idempotencyKey: id(),
      });
      db.prepare(
        "UPDATE runs SET payload=json_set(payload,'$.connectionId','agy','$.provider','antigravity') WHERE id=?",
      ).run(queued.id);
      const dispatch = vi.spyOn(nativeSessions, "execute");
      try {
        await expect(
          executeAgent(ownedRun(queued.id, "alice")),
        ).rejects.toThrow(/workspace tools/);
        expect(dispatch).not.toHaveBeenCalled();
        expect(
          db
            .prepare("SELECT 1 FROM native_dispatch WHERE run_id=?")
            .get(queued.id),
        ).toBeUndefined();
      } finally {
        dispatch.mockRestore();
      }
      const counts = () =>
        ["runs", "conversations", "delegations", "code_reviews"].map((table) =>
          db.prepare(`SELECT count(*) n FROM ${table}`).get(),
        );
      const before = counts();
      for (const member of [manager, worker]) {
        db.prepare(
          "UPDATE agents SET connection_id='agy',provider='antigravity' WHERE id=?",
        ).run(member.id);
        expect(() =>
          submit("alice", {
            agentId: member.id,
            ...(member.id === worker.id ? { teamId: team.id } : {}),
            input: "Unsupported legacy team",
            idempotencyKey: id(),
          }),
        ).toThrow(/workspace tools/);
      }
      expect(counts()).toEqual(before);

      if (profile === "companion") {
        const folder = id();
        db.prepare(
          "INSERT INTO folders VALUES(?,'alice',NULL,'project','Fixture',0)",
        ).run(folder);
        db.prepare("INSERT INTO project_paths VALUES(?,?)").run(folder, dir);
        const reviewTeam = createPresetTeam("alice", {
          presetId: "code-review",
          name: "Reviewers",
          folderId: folder,
          selection: { connectionId: "api", model: "fixture" },
          idempotencyKey: id(),
        });
        for (const agentId of [reviewTeam.manager_id, reviewTeam.members[0]]) {
          expect((await patch(agentId)).status).toBe(409);
          db.prepare(
            "UPDATE agents SET connection_id='agy',provider='antigravity' WHERE id=?",
          ).run(agentId);
          const beforeReview = counts();
          expect(() =>
            startCodeReview("alice", reviewTeam.id, {
              folderId: folder,
              scope: "uncommitted",
              base: "main",
              idempotencyKey: id(),
            }),
          ).toThrow(/workspace tools/);
          expect(counts()).toEqual(beforeReview);
          db.prepare(
            "UPDATE agents SET connection_id='api',provider='openai' WHERE id=?",
          ).run(agentId);
        }
      }
      deleteTeam("alice", team.id);
      expect((await patch(manager.id)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await nativeSessions.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
