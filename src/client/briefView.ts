import type { BriefPage, BriefSource } from "../shared/briefs";

export function briefAttentionUrl(
  need: BriefPage["needs_you"][number],
  target: { conversation: string; message: string | null },
  workspace = "",
) {
  if (need.kind === "not_sent") {
    const params = new URLSearchParams({
      page: "profile",
      later: "scheduled",
      laterItem: need.ref,
    });
    if (workspace) params.set("source", workspace);
    return "/?" + params;
  }
  return briefSourceUrl({ ...target, artifact: null }, workspace) ?? "/";
}

export function briefSourceUrl(
  source: Pick<BriefSource, "conversation" | "message" | "artifact"> &
    Pick<Partial<BriefSource>, "kind" | "run">,
  workspace = "",
) {
  const params = new URLSearchParams();
  if (workspace) params.set("source", workspace);
  if (source.conversation) {
    // A published result without a message anchor opens the actual file.
    if (source.artifact && !source.message) {
      params.set("artifact", source.artifact);
      return "/?" + params;
    }
    params.set("conversation", source.conversation);
    if (source.message) params.set("message", source.message);
    if (
      source.run &&
      (source.kind === "checkout" || source.kind === "verification")
    )
      params.set(source.kind, source.run);
  } else if (source.artifact) params.set("artifact", source.artifact);
  else return null;
  return "/?" + params;
}

/** Called after rendering; concurrent refreshes share the same acknowledgement. */
export class BriefAcknowledgements {
  private sent = new Map<number, Promise<void>>();
  acknowledge(
    version: number,
    acknowledged: number,
    send: (version: number) => Promise<unknown>,
  ): Promise<void> {
    if (version <= acknowledged) return Promise.resolve();
    const pending = this.sent.get(version);
    if (pending) return pending;
    const request = Promise.resolve()
      .then(() => send(version))
      .then(
        () => {},
        (error) => {
          this.sent.delete(version);
          throw error;
        },
      );
    this.sent.set(version, request);
    return request;
  }
}
