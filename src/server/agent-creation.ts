import { createHash } from "node:crypto";
import { z } from "zod";
import { db, id, now } from "./db.js";
import { agentInput, createAgent, owned, Problem } from "./domain.js";
import { submit } from "./agent-runtime.js";
import type { Agent, CreatedAgent, Run } from "../shared/types.js";

const input = agentInput.extend({
  initialPrompt: z.string().trim().max(30000).default(""),
  folderId: z.string().optional(),
  idempotencyKey: z.string().min(8).max(150).optional(),
});

export function createWithPrompt(owner: string, value: unknown): CreatedAgent {
  const { idempotencyKey = id(), ...data } = input.parse(value);
  // Keep the existing receipt serialization order when membership becomes an
  // agent field, so an acknowledgement lost before upgrade can still retry.
  const { folderId, ...details } = data;
  const hash = createHash("sha256")
    .update(JSON.stringify({ ...details, folderId: folderId || null }))
    .digest("hex");
  return db
    .transaction(() => {
      const receipt = db
        .prepare(
          "SELECT * FROM agent_creations WHERE owner_id=? AND request_key=?",
        )
        .get(owner, idempotencyKey) as
        | {
            request_hash: string;
            agent_id: string;
            run_id: string | null;
          }
        | undefined;
      if (receipt) {
        if (receipt.request_hash !== hash)
          throw new Problem(
            409,
            "This request key belongs to different agent details.",
          );
        const agent = owned<Agent>("agents", receipt.agent_id, owner);
        const run = receipt.run_id
          ? owned<Run>("runs", receipt.run_id, owner)
          : undefined;
        return {
          ...agent,
          ...(run
            ? {
                initialRun: {
                  id: run.id,
                  conversation_id: run.conversation_id,
                },
              }
            : {}),
        };
      }
      if (data.folderId) owned("folders", data.folderId, owner);
      const agent = createAgent(owner, data);
      const run = data.initialPrompt
        ? submit(owner, {
            agentId: agent.id,
            input: data.initialPrompt,
            folderId: data.folderId || undefined,
            idempotencyKey: "agent-initial:" + agent.id,
          })
        : undefined;
      db.prepare("INSERT INTO agent_creations VALUES(?,?,?,?,?,?)").run(
        owner,
        idempotencyKey,
        hash,
        agent.id,
        run?.id || null,
        now(),
      );
      return {
        ...agent,
        ...(run
          ? { initialRun: { id: run.id, conversation_id: run.conversation_id } }
          : {}),
      };
    })
    .immediate();
}
