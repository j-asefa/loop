import { db, now } from "./db.js";
import { saveArtifact } from "./artifacts.js";
import type { Run } from "./queue.js";
import type { ArtifactMetadataInput } from "../shared/artifact-metadata.js";
import * as messages from "./sql/messages.js";
import * as artifacts from "./sql/artifacts.js";
import * as versions from "./sql/artifact-versions.js";
import * as checkpoints from "./sql/agent-checkpoints.js";
import * as runs from "./sql/runs.js";

type AnswerMetadata = Extract<
  ArtifactMetadataInput,
  { role: "answer" }
>["metadata"];
type AnswerIds = { message_id: string; artifact_id: string };
type Creation = {
  messageId: string;
  title: string;
  folder?: string | null;
  messageMetadata: string;
  artifactMetadata: AnswerMetadata;
};
export type AnswerContent = {
  output: string;
  messageMetadata: string;
  artifactMetadata: string;
};

// All operations run within the caller's existing transaction. Scheduling,
// native churn checks, history and external dispatch stay with their writers.
function create(run: Run, input: Creation, content: string): AnswerIds {
  messages.insert(
    db,
    input.messageId,
    run.owner_id,
    run.conversation_id,
    run.id,
    "assistant",
    content,
    input.messageMetadata,
    now(),
  );
  const artifact = saveArtifact(run.owner_id, {
    title: input.title,
    content,
    agent: run.agent_id,
    conversation: run.conversation_id,
    run: run.id,
    folder: input.folder,
    role: "answer",
    metadata: { ...input.artifactMetadata, messageId: input.messageId },
  });
  return { message_id: input.messageId, artifact_id: artifact };
}
export function openAnswer(
  run: Run,
  input: Creation & { history: string },
): AnswerIds {
  const answer = create(run, input, "");
  checkpoints.insert(
    db,
    run.id,
    answer.message_id,
    answer.artifact_id,
    input.history,
  );
  return answer;
}

// Both real writers update these three records in this order. Their artifact
// predicates differ for historical version rows, so keep the two SQL policies.
function writeContent(
  answer: AnswerIds,
  content: AnswerContent,
  writeArtifact: typeof artifacts.streamInitial,
) {
  messages.updateContentAndMetadata(
    db,
    content.output,
    content.messageMetadata,
    answer.message_id,
  );
  writeArtifact(
    db,
    content.output,
    content.artifactMetadata,
    now(),
    answer.artifact_id,
  );
  versions.updateInitialContent(db, content.output, answer.artifact_id);
}
export function writeManagedAnswer(
  run: Run,
  answer: AnswerIds,
  content: AnswerContent,
) {
  writeContent(answer, content, artifacts.streamInitial);
  checkpoints.output(db, content.output, run.id);
}
export function finishManagedAnswer(
  run: Run,
  output: string,
  round: number,
  history: string,
) {
  // The caller has already persisted the final body in its nested transaction.
  saveResult(run, output);
  checkpoints.done(db, round, history, run.id);
}
export function writeNativeAnswer(
  run: Run,
  answer: AnswerIds,
  content: AnswerContent,
  stage: "native" | "done",
) {
  writeContent(answer, content, artifacts.updateNativeOutput);
  checkpoints.nativeOutput(db, content.output, stage, run.id);
  // Native partial projections also set result; managed partial writes do not.
  saveResult(run, content.output);
}
export function createPreviewAnswer(
  run: Run,
  input: Creation,
  output: string,
): AnswerIds {
  const answer = create(run, input, output);
  checkpoints.previewComplete(
    db,
    run.id,
    answer.message_id,
    answer.artifact_id,
    "[]",
    output,
  );
  saveResult(run, output);
  return answer;
}
function saveResult(run: Run, output: string) {
  runs.setResult(db, output, run.id);
}
