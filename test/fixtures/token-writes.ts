import { failNextTokenCompletion } from "../helpers/token-completion-hook.js";
import express from "express";
import Database from "better-sqlite3";
import { db, id, now } from "../../src/server/db.js";
import { enqueue, claim } from "../../src/server/queue.js";
import { nativeSessions, type Live } from "../../src/server/native-sessions.js";
import { OWNER } from "../../src/server/workspace-identity.js";
import { NativeOutput } from "../../src/server/native-output.js";

// Fault injection is IPC-only and installed in the isolated fixture process.
// The actual registrar, identity store, routes and native authority run normally.
export function loseTokenResponse() {
  const json = express.response.json;
  express.response.json = function (body) {
    if (this.locals.bearer && this.req.method === "POST") {
      express.response.json = json;
      this.socket?.destroy();
      return this;
    }
    return json.call(this, body);
  };
}

export function failTokenCompletion() {
  failNextTokenCompletion();
}

export function nativeTokenDecision(fail: boolean) {
  const conversation = id(),
    generation = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,'Native token fixture',?)",
  ).run(conversation, OWNER, now());
  const queued = enqueue(OWNER, "Native token fixture", id(), { conversation });
  const run = claim(
    "token-native-fixture",
    (candidate) => candidate.id === queued.id,
  )!;
  db.prepare(
    "INSERT INTO companion_sessions(worktree_agent_id,conversation_id,harness,project,generation,updated_at) VALUES('fixture-agent',?,'codex',?,?,?)",
  ).run(conversation, process.cwd(), generation, now());
  const live = {
    run,
    binding: { conversation_id: conversation, generation, harness: "codex" },
    generation,
    adapter: {
      answer: async () => {
        // This durable fixture counter also proves pending was committed before
        // crossing the adapter boundary, using a separate reader in the test.
        const reader = new Database(db.name, { readonly: true });
        try {
          const row = reader
            .prepare(
              "SELECT state FROM token_requests WHERE operation='nativeAnswer' AND identity=(SELECT command_id FROM native_decisions WHERE id=?)",
            )
            .get(decision) as { state: string } | undefined;
          if (!row)
            throw new Error("Native effect started before pending committed");
          db.prepare(
            "INSERT INTO fixture_token_dispatches(decision,receipt_state) VALUES(?,?)",
          ).run(decision, row.state);
        } finally {
          reader.close();
        }
        if (fail) throw new Error("Fixture lost native response");
      },
      dispose: async () => {},
    },
    requests: new Map(),
    items: new NativeOutput(),
    closed: false,
    waiting: false,
    finish: () => {},
  } as unknown as Live;
  (nativeSessions as unknown as { live: Map<string, Live> }).live.set(
    conversation,
    live,
  );
  nativeSessions.projector.event(live, {
    type: "request",
    request: {
      id: id(),
      kind: "approval",
      title: "Fixture permission",
      detail: "Fixture tool request",
      choices: ["allow", "deny"],
    },
  });
  const { id: decision } = db
    .prepare("SELECT id FROM native_decisions WHERE run_id=?")
    .get(run.id) as { id: string };
  db.exec(
    "CREATE TABLE IF NOT EXISTS fixture_token_dispatches(decision TEXT,receipt_state TEXT)",
  );
  return { decision, run: run.id, conversation, generation };
}
