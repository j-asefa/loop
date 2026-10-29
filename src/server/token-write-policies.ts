import { z } from "zod";
import { PublicRun } from "../shared/workspace-api.js";
import { PublicWithdrawnDraft } from "../shared/mobile-contract-schemas.js";
import { db } from "./db.js";
import { ownedApproval, ownedRun, ownedRunControl, Problem } from "./domain.js";
import { runResponse } from "./row-schemas.js";
import { tokenWrite, type TokenRequest } from "./token-requests.js";

const Target = z.object({ id: z.string() });
const RunLocator = z.object({
  run: z.string(),
  steering: z.string().optional(),
});
const DraftLocator = z.object({ run: z.string(), draft: PublicWithdrawnDraft });
const ApprovalLocator = z.object({
  approval: z.string(),
  run: z.string(),
  digest: z.string(),
});
const DecisionLocator = z.object({
  decision: z.string(),
  generation: z.string(),
});
const unavailable = () =>
  new Problem(
    409,
    "The original request's result is unavailable. Its effect will not be repeated.",
  );

function locator<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}
function runExists(owner: string, run: string) {
  if (
    !db.prepare("SELECT 1 FROM runs WHERE id=? AND owner_id=?").get(run, owner)
  )
    throw unavailable();
}
function prepareRun(request: TokenRequest) {
  const { id } = Target.parse(request.input.params);
  ownedRunControl(id, request.owner);
  return { run: id };
}
function resultRun(_request: TokenRequest, response: unknown) {
  const run = PublicRun.parse(response);
  return {
    run: run.id,
    ...(run.steeringId ? { steering: run.steeringId } : {}),
  };
}
function projectRun(owner: string, value: unknown) {
  const saved = locator(RunLocator, value);
  runExists(owner, saved.run);
  if (
    saved.steering &&
    !db
      .prepare(
        "SELECT 1 FROM run_steering WHERE id=? AND owner_id=? AND run_id=?",
      )
      .get(saved.steering, owner, saved.run)
  )
    throw unavailable();
  return {
    ...runResponse(ownedRun(saved.run, owner)),
    ...(saved.steering ? { steeringId: saved.steering } : {}),
  };
}
function projectAcknowledgement(owner: string, value: unknown) {
  runExists(owner, locator(RunLocator, value).run);
  return { ok: true };
}

// submit() commits either an enqueued run or a durable steering message. The
// worker owns later delivery, so its receipt belongs in this local transaction.
// Its existing owner-wide key also reconciles the same send from another token.
export const submitTokenWrite = tokenWrite({
  mode: "local",
  locate: resultRun,
  project: projectRun,
});
export const moveTokenWrite = tokenWrite({
  mode: "local",
  prepare: prepareRun,
  locate: resultRun,
  project: projectRun,
});
export const reorderTokenWrite = tokenWrite({
  mode: "local",
  prepare: prepareRun,
  locate: (_request, _response, prepared) => prepared,
  project: projectAcknowledgement,
});
export const runControlTokenWrite = tokenWrite({
  mode: "local",
  prepare: (request) => {
    const { action } = z
      .object({ action: z.string() })
      .parse(request.input.params);
    if (action !== "cancel" && action !== "dismiss")
      throw new Problem(
        403,
        "This token permits only cancel and dismiss run actions.",
      );
    return prepareRun(request);
  },
  locate: (_request, _response, prepared) => prepared,
  project: projectAcknowledgement,
});
export const withdrawTokenWrite = tokenWrite({
  mode: "local",
  prepare: prepareRun,
  locate: (_request, response, prepared) => ({
    ...locator(RunLocator, prepared),
    draft: PublicWithdrawnDraft.parse(response),
  }),
  project: (owner, value) => {
    const saved = locator(DraftLocator, value);
    runExists(owner, saved.run);
    // Withdraw creates no durable draft row. Retain only its public response;
    // replay never invokes withdrawal or restores a second composer draft.
    return saved.draft;
  },
});
export const approvalTokenWrite = tokenWrite({
  mode: "local",
  prepare: (request) => {
    const approval = ownedApproval(
      Target.parse(request.input.params).id,
      request.owner,
    );
    // API approvals have an immutable request digest, not a session generation.
    return {
      approval: approval.id,
      run: approval.run_id,
      digest: approval.digest,
    };
  },
  locate: (_request, _response, prepared) => prepared,
  project: (owner, value) => {
    const saved = locator(ApprovalLocator, value);
    if (
      !db
        .prepare(
          "SELECT 1 FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id WHERE a.id=? AND a.owner_id=? AND a.run_id=? AND a.digest=?",
        )
        .get(saved.approval, owner, saved.run, saved.digest)
    )
      throw unavailable();
    return { ok: true };
  },
});
export const nativeAnswerTokenWrite = tokenWrite({
  mode: "external",
  prepare: (request) => {
    const decision = Target.parse(request.input.params).id;
    const row = db
      .prepare(
        "SELECT d.generation FROM native_decisions d JOIN runs r ON r.id=d.run_id JOIN conversations c ON c.id=d.conversation_id WHERE d.id=? AND r.owner_id=? AND c.owner_id=?",
      )
      .get(decision, request.owner, request.owner) as
      { generation: string } | undefined;
    if (!row) throw new Problem(404, "Native decision not found.");
    return { decision, generation: row.generation };
  },
  locate: (_request, _response, prepared) => prepared,
  project: (owner, value) => {
    const saved = locator(DecisionLocator, value);
    const row = db
      .prepare(
        "SELECT d.state FROM native_decisions d JOIN runs r ON r.id=d.run_id JOIN conversations c ON c.id=d.conversation_id WHERE d.id=? AND d.generation=? AND r.owner_id=? AND c.owner_id=?",
      )
      .get(saved.decision, saved.generation, owner, owner) as
      { state: string } | undefined;
    if (!row) throw unavailable();
    return { state: row.state };
  },
});
