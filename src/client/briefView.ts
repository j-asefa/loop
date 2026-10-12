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
  source: Pick<BriefSource, "conversation" | "message" | "artifact">,
  workspace = "",
) {
  const params = new URLSearchParams();
  if (workspace) params.set("source", workspace);
  if (source.conversation) {
    params.set("conversation", source.conversation);
    if (source.message) params.set("message", source.message);
  } else if (source.artifact) params.set("artifact", source.artifact);
  else return null;
  return "/?" + params;
}

/** Called after rendering; concurrent refreshes share the same acknowledgement. */
export class BriefAcknowledgements {
  private sent = new Set<number>();
  async acknowledge(
    version: number,
    acknowledged: number,
    send: (version: number) => Promise<unknown>,
  ) {
    if (version <= acknowledged || this.sent.has(version)) return;
    this.sent.add(version);
    try {
      await send(version);
    } catch (error) {
      this.sent.delete(version);
      throw error;
    }
  }
}
