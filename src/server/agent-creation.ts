import { createHash } from "node:crypto";
import { z } from "zod";
import { db, id, now } from "./db.js";
import { ownedFolder, ownedAgent, ownedRun, agentInput, createAgent, Problem } from "./domain.js";
import { submit } from "./agent-runtime.js";
import { attachmentIds } from "./uploads.js";
import type { CreatedAgent } from "../shared/types.js";

const input = agentInput.extend({
  initialPrompt: z.string().trim().max(30000).default(""),
  attachmentIds,
  folderId: z.string().optional(),
  idempotencyKey: z.string().min(8).max(150).optional(),
});

export function createWithPrompt(owner: string, value: unknown): CreatedAgent {
  const { idempotencyKey = id(), ...data } = input.parse(value);
  // Keep the existing receipt serialization order when membership becomes an
  // agent field, so an acknowledgement lost before upgrade can still retry.
  const { folderId, attachmentIds: files, ...details } = data;
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        ...details,
        folderId: folderId || null,
        // Preserve receipts from clients that created an agent before uploads
        // were supported. File order and identity matter when files are present.
        ...(files.length ? { attachmentIds: files } : {}),
      }),
    )
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
        const agent = ownedAgent(receipt.agent_id, owner);
        const run = receipt.run_id
          ? ownedRun(receipt.run_id, owner)
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
      if (files.length && !data.initialPrompt)
        throw new Problem(400, "Add an initial prompt for these files.");
      if (data.folderId) ownedFolder(data.folderId, owner);
      const agent = createAgent(owner, data);
      const run = data.initialPrompt
        ? submit(owner, {
            agentId: agent.id,
            personal: true,
            input: data.initialPrompt,
            attachmentIds: files,
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
