// Named currency policies. Dispatch checks the attached turn, generation,
// cancellation and active run state; decision answers also check their
// delivery receipt. Delayed output requires the same run object. Stored-
// generation checks stay specific to settings and usage, activity and model
// projections and are not added to prompt or decision dispatch; definitive
// non-delivery can reopen a decision without the dispatch cancellation check.
import type { Live } from "./state.js";
import type { Run } from "../queue.js";

type PreparationBinding = Pick<
  NonNullable<ReturnType<typeof import("../sql/companion-sessions.js").get>>,
  "generation" | "harness" | "project" | "worktree_agent_id" | "worktree_source"
>;
type Turn = {
  live: Live;
  generation: string;
  runId: string;
  conversation?: string;
};
type Receipt = {
  state: string;
  command_id: string | null;
  digest: string | null;
};
export type NativeCurrencyCheck =
  | { kind: "event" | "dispose-entry"; live: Live }
  | { kind: "decision-wait" | "bridge-turn"; live: Live; runId: string }
  | { kind: "output-flush"; live: Live; run: Run }
  | {
      kind: "session-access";
      live: Live | undefined;
      generation: string | null;
      requireRun: boolean;
    }
  | {
      kind: "settings";
      conversation: string;
      live: Live;
      generation: string;
      storedGeneration: string | null | undefined;
    }
  | {
      kind: "settings-dispatch";
      conversation: string;
      live: Live;
      generation: string;
      storedGeneration: string | null | undefined;
      run: Run | undefined;
      setting: string;
    }
  | ({ kind: "input-dispatch"; state: () => string } & Turn)
  | ({
      kind: "decision-admission";
      decisionState: string;
      state: string;
    } & Turn)
  | ({
      kind: "answer-dispatch";
      receipt: Receipt | undefined;
      commandId: string;
      digest: string;
      state: () => string;
    } & Turn)
  | ({ kind: "decision-reopen"; state: string | undefined } & Turn)
  | {
      kind: "stored-projection" | "harness-switch";
      storedGeneration: string | null | undefined;
      generation: string;
    }
  | { kind: "usage"; live: Live; storedGeneration: string | null | undefined }
  | {
      kind: "session-preparation";
      conversation: string;
      live: Live | undefined;
      before: PreparationBinding | undefined;
      latest: PreparationBinding | undefined;
      state: string;
      currentState: () => string;
    };

/** The existing native currency policies, including their deliberate differences.
 * Reads stay at the callers' original boundaries; state callbacks preserve the
 * short-circuit before an owned run read. This guard never mutates a session.
 */
export class NativeSessionCurrency {
  constructor(
    private readonly sessions: Pick<ReadonlyMap<string, Live>, "get">,
  ) {}

  allows(check: NativeCurrencyCheck): boolean {
    const active = (state: string | undefined) =>
      state === "running" || state === "awaiting_approval";
    const attached = (
      live: Live,
      conversation = live.binding.conversation_id,
    ) => this.sessions.get(conversation) === live;
    const open = (live: Live, conversation?: string) =>
      attached(live, conversation) && !live.closed;
    const turn = (value: Turn) =>
      !value.live.closed &&
      value.live.generation === value.generation &&
      value.live.run?.id === value.runId;
    switch (check.kind) {
      case "event":
        return open(check.live);
      case "dispose-entry":
        return attached(check.live);
      case "bridge-turn":
        return check.live.run?.id === check.runId;
      case "decision-wait":
        return open(check.live) && check.live.run?.id === check.runId;
      case "output-flush":
        return open(check.live) && check.live.run === check.run;
      case "session-access":
        return (
          !!check.live &&
          !check.live.closed &&
          check.live.generation === check.generation &&
          (!check.requireRun || !!check.live.run)
        );
      case "settings":
      case "settings-dispatch":
        return (
          open(check.live, check.conversation) &&
          check.live.generation === check.generation &&
          check.storedGeneration === check.generation &&
          (check.kind === "settings" ||
            (check.live.run === check.run &&
              !check.live.cancelling &&
              (!check.run || (check.setting === "mode" && check.live.waiting))))
        );
      case "input-dispatch":
        return (
          attached(check.live, check.conversation) &&
          turn(check) &&
          !check.live.cancelling &&
          active(check.state())
        );
      case "decision-admission":
        return (
          turn(check) &&
          check.decisionState === "pending" &&
          active(check.state)
        );
      case "answer-dispatch":
        return (
          attached(check.live, check.conversation) &&
          turn(check) &&
          !check.live.cancelling &&
          check.receipt?.state === "deciding" &&
          check.receipt.command_id === check.commandId &&
          check.receipt.digest === check.digest &&
          active(check.state())
        );
      case "decision-reopen":
        return (
          attached(check.live, check.conversation) &&
          turn(check) &&
          active(check.state)
        );
      case "harness-switch":
      case "stored-projection":
        return check.storedGeneration === check.generation;
      case "usage":
        return (
          !!check.live.run &&
          check.live.run.conversation_id ===
            check.live.binding.conversation_id &&
          check.storedGeneration === check.live.generation
        );
      case "session-preparation":
        return (
          this.sessions.get(check.conversation) === check.live &&
          !check.live?.closed &&
          check.currentState() === check.state &&
          !!check.latest === !!check.before &&
          (
            [
              "generation",
              "harness",
              "project",
              "worktree_agent_id",
              "worktree_source",
            ] as const
          ).every((key) => check.latest?.[key] === check.before?.[key])
        );
    }
  }
}
