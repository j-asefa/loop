import * as agentCreationsQueries from "./sql/agent-creations.js";
import { withCreationReceipt } from "./request-receipts.js";
import { AgentCreateInput } from "../shared/agent-contract-schemas.js";
import { db, id, now } from "./db.js";
import {
  ownedFolder,
  ownedAgent,
  ownedRun,
  createAgent,
  Problem,
} from "./domain.js";
import { submit } from "./agent-runtime.js";
import type { CreatedAgent } from "../shared/types.js";

export function createWithPrompt(owner: string, value: unknown): CreatedAgent {
  const { idempotencyKey = id(), ...data } = AgentCreateInput.parse(value);
  const { folderId, attachmentIds: files, ...details } = data;
  return withCreationReceipt(
    db,
    {
      owner,
      key: idempotencyKey,
      input: { ...details, folderId: folderId || null, attachmentIds: files },
    },
    {
      read: (owner, key) => agentCreationsQueries.byRequest(db, owner, key),
      conflict: "This request key belongs to different agent details.",
      recover: (receipt) => {
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
      },
      create: () => {
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
      },
      record: (owner, key, hash, result) => {
        agentCreationsQueries.insert(
          db,
          owner,
          key,
          hash,
          result.id,
          result.initialRun?.id || null,
          now(),
        );
      },
    },
  );
}
