import { expect } from "vitest";
import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { seedConversation } from "../helpers/seed.js";

export function assertAnswerStored(
  db: Database.Database,
  run: string,
  output: string,
) {
  const cp = db
    .prepare("SELECT * FROM agent_checkpoints WHERE run_id=?")
    .get(run) as {
    message_id: string;
    artifact_id: string;
    stage: string;
    output: string;
  };
  expect(cp).toMatchObject({ stage: "done", output });
  const message = db
    .prepare("SELECT id,owner_id,content FROM messages WHERE id=?")
    .get(cp.message_id) as { id: string; owner_id: string; content: string };
  const artifact = db
    .prepare(
      "SELECT id,owner_id,content,role,metadata FROM artifacts WHERE id=?",
    )
    .get(cp.artifact_id) as {
    id: string;
    owner_id: string;
    content: string;
    role: string;
    metadata: string;
  };
  expect(message.content).toBe(output);
  expect(artifact).toMatchObject({
    content: output,
    role: "answer",
    owner_id: message.owner_id,
  });
  expect(JSON.parse(artifact.metadata).messageId).toBe(message.id);
  expect(
    db
      .prepare(
        "SELECT content FROM artifact_versions WHERE artifact_id=? AND version=1",
      )
      .get(artifact.id),
  ).toEqual({ content: output });
  expect(db.prepare("SELECT result FROM runs WHERE id=?").get(run)).toEqual({
    result: output,
  });
  return {
    message: message.content,
    artifact: artifact.content,
    output: cp.output,
    stage: cp.stage,
  };
}

// Expanded within the existing native projection case: no parallel replacement
// test suite. Exercise the record interface and a fresh writer process on disk.
export async function exerciseAnswerRecord() {
  const { db, id } = await import("../../src/server/db.js");
  const { enqueue, claim, transition } =
    await import("../../src/server/queue.js");
  const records = await import("../../src/server/answer-record.js");
  const checkpoints = await import("../../src/server/sql/agent-checkpoints.js");
  const created: ReturnType<typeof enqueue>[] = [];
  const createRun = () => {
    const conversation = id();
    seedConversation(db, {
      id: conversation,
      owner_id: "owner",
      title: "answer fixture",
      created_at: 0,
    });
    const queued = enqueue("owner", "Answer fixture", id(), { conversation });
    const run = claim(
      "answer-record-fixture",
      (candidate) => candidate.id === queued.id,
    )!;
    created.push(run);
    return run;
  };
  const opened = (run: ReturnType<typeof createRun>, native: boolean) =>
    db
      .transaction(() =>
        records.openAnswer(run, {
          messageId: id(),
          title: "Answer fixture",
          history: "[]",
          messageMetadata: native ? "{}" : '{"partial":true}',
          artifactMetadata: native ? { native: true } : {},
        }),
      )
      .immediate();
  try {
    const finalShapes: ReturnType<typeof assertAnswerStored>[] = [];
    for (const native of [false, true]) {
      for (const partial of [false, true]) {
        const run = createRun(),
          answer = opened(run, native);
        expect(checkpoints.get(db, run.id)).toMatchObject({
          ...answer,
          stage: "model",
          output: "",
          history: "[]",
        });
        expect(
          JSON.parse(
            (
              db
                .prepare("SELECT metadata FROM messages WHERE id=?")
                .get(answer.message_id) as { metadata: string }
            ).metadata,
          ),
        ).toEqual(native ? {} : { partial: true });
        const content = (output: string, isPartial: boolean) => ({
          output,
          messageMetadata: JSON.stringify({
            partial: isPartial,
            ...(native ? { native: true } : {}),
            messageId: answer.message_id,
          }),
          artifactMetadata: JSON.stringify({
            ...(native ? { native: true } : {}),
            messageId: answer.message_id,
          }),
        });
        if (partial) {
          db.transaction(() => {
            if (native)
              records.writeNativeAnswer(
                run,
                answer,
                content("", true),
                "native",
              );
            else
              records.writeManagedAnswer(run, answer, content("Draft", true));
          }).immediate();
          expect(checkpoints.get(db, run.id)).toMatchObject({
            stage: native ? "native" : "model",
            output: native ? "" : "Draft",
          });
          expect(
            db.prepare("SELECT result FROM runs WHERE id=?").get(run.id),
          ).toEqual({ result: native ? "" : null });
        }
        db.transaction(() => {
          if (native)
            records.writeNativeAnswer(
              run,
              answer,
              content("Final answer", false),
              "done",
            );
          else {
            db.transaction(() =>
              records.writeManagedAnswer(
                run,
                answer,
                content("Final answer", false),
              ),
            ).immediate();
            records.finishManagedAnswer(run, "Final answer", 1, "[]");
          }
        }).immediate();
        finalShapes.push(assertAnswerStored(db, run.id, "Final answer"));
      }
    }
    expect(
      finalShapes.every(
        (shape) => JSON.stringify(shape) === JSON.stringify(finalShapes[0]),
      ),
    ).toBe(true);

    // Historical rows need not have a version pointer consistent with the rows.
    // Preserve each writer's original predicate instead of treating them as equal.
    for (const native of [false, true])
      for (const futureRow of [false, true]) {
        const run = createRun(),
          answer = opened(run, native);
        if (futureRow)
          db.prepare(
            "INSERT INTO artifact_versions(id,artifact_id,version,content,created_at) VALUES(?,?,2,'Edited',0)",
          ).run(id(), answer.artifact_id);
        else
          db.prepare("UPDATE artifacts SET version=2 WHERE id=?").run(
            answer.artifact_id,
          );
        const content = {
          output: "Final",
          messageMetadata: "{}",
          artifactMetadata: JSON.stringify({ messageId: answer.message_id }),
        };
        db.transaction(() => {
          if (native) records.writeNativeAnswer(run, answer, content, "done");
          else records.writeManagedAnswer(run, answer, content);
        }).immediate();
        expect(
          db
            .prepare("SELECT content FROM artifacts WHERE id=?")
            .get(answer.artifact_id),
        ).toEqual({ content: native === futureRow ? "Final" : "" });
      }

    const restart = createRun(),
      answer = opened(restart, false);
    db.transaction(() =>
      records.writeManagedAnswer(restart, answer, {
        output: "Durable draft",
        messageMetadata: '{"partial":true}',
        artifactMetadata: JSON.stringify({ messageId: answer.message_id }),
      }),
    ).immediate();
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
    const { db } = await import('./src/server/db.ts');
    const { ownedRun } = await import('./src/server/domain.ts');
    const { get } = await import('./src/server/sql/agent-checkpoints.ts');
    const { writeManagedAnswer, finishManagedAnswer } = await import('./src/server/answer-record.ts');
    const run = ownedRun(process.argv[1], 'owner'), answer = get(db, run.id);
    if (answer.output !== 'Durable draft') throw new Error('Checkpoint did not survive writer restart');
    db.transaction(() => {
      writeManagedAnswer(run, answer, { output: 'Recovered final', messageMetadata: '{"partial":false}', artifactMetadata: JSON.stringify({ messageId: answer.message_id }) });
      finishManagedAnswer(run, 'Recovered final', 1, '[]');
    }).immediate();
    db.close();
    process.exit(0);
  `,
        restart.id,
      ],
      { env: process.env, timeout: 15000, stdio: "pipe" },
    );
    assertAnswerStored(db, restart.id, "Recovered final");
  } finally {
    for (const run of created) transition(run, "completed");
  }
}
