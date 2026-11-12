import { describe, expect, it, vi } from "vitest";
import { composerLaunchRecipient } from "../src/client/composerLaunch";
import { renderComposer } from "../src/client/app/Composer";
import type { Agent } from "../src/shared/types";

function agent(id: string, name: string): Agent {
  return {
    id,
    owner_id: "owner",
    name,
    provider: "anthropic",
    connection_id: null,
    model: "claude",
    instructions: "",
    origin: "loop",
    created_at: 0,
  };
}

describe("composer launch recipient", () => {
  const holly = agent("holly", "holly");
  const mist = agent("mist", "mist");
  const agents = [holly, mist];

  it("defaults to the profile agent over the last recipient", () => {
    // On @holly's profile, "+" must open the chat box addressed to @holly,
    // not to @mist just because @mist received the previous send.
    expect(composerLaunchRecipient(agents, holly, "mist")?.id).toBe("holly");
    expect(composerLaunchRecipient(agents, holly, null)?.id).toBe("holly");
  });

  it("restores the last recipient when not on an agent profile", () => {
    expect(composerLaunchRecipient(agents, null, "mist")?.id).toBe("mist");
    expect(composerLaunchRecipient(agents, undefined, "mist")?.id).toBe("mist");
  });

  it("leaves the current recipient alone when nothing defaults", () => {
    expect(composerLaunchRecipient(agents, null, null)).toBeUndefined();
    expect(composerLaunchRecipient(agents, null, "gone")).toBeUndefined();
    expect(composerLaunchRecipient([], holly, "mist")).toBeUndefined();
  });

  it("launches the composer addressed to the profile agent", () => {
    const hollyAgent = agent("holly", "holly");
    const mistAgent = agent("mist", "mist");
    const both = [hollyAgent, mistAgent];
    const setSelected = vi.fn();
    const setFolder = vi.fn();
    const focusComposer = vi.fn();
    vi.stubGlobal("localStorage", {
      getItem: () => "mist",
      setItem: () => {},
      removeItem: () => {},
    });
    try {
      const { launchComposer } = renderComposer({
        profile: hollyAgent,
        replyContext: null,
        replyQuoted: undefined,
        contextArtifact: null,
        conversation: null,
        threadMode: false,
        selected: "mist",
        routePreview: null,
        busy: false,
        uploading: false,
        draft: "",
        activeAgent: mistAgent,
        conversationTarget: null,
        send: async () => {},
        sendPress: {},
        composerData: { agents: both, connections: [], folders: [] },
        availableAgents: both,
        composerRef: { current: null },
        composerExpanded: false,
        workspaceReady: true,
        composerOptions: false,
        setComposerOptions: vi.fn(),
        startChat: vi.fn(),
        sendNotice: null,
        sentRun: undefined,
        setSelected,
        setConversation: vi.fn(),
        setSendNotice: vi.fn(),
        attachments: [],
        session: { user: { id: "owner" } },
        setContextArtifact: vi.fn(),
        setFolderChoice: vi.fn(),
        setFolder,
        focusComposer,
        destination: {
          agent: "mist",
          project: "Unfiled",
          thread: "New thread",
        },
        data: { agents: both },
        setReplyContext: vi.fn(),
        collapseComposer: vi.fn(),
        steersActive: false,
        setDraft: vi.fn(),
        setComposerExpanded: vi.fn(),
        setAttachments: vi.fn(),
        composerError: "",
        setComposerError: vi.fn(),
        folderChoice: undefined,
        threadIdentity: "thread",
        setUploading: vi.fn(),
        viewIdentity: "view",
        threadIdentityRef: { current: "" },
        attachmentsRef: { current: [] },
        setSheet: vi.fn(),
        setModelAgent: vi.fn(),
        setSendMenu: vi.fn(),
        threadWork: null,
        threadNotice: "",
        setThreadNotice: vi.fn(),
      } as Parameters<typeof renderComposer>[0]);
      launchComposer();
      expect(setSelected).toHaveBeenCalledWith("holly");
      expect(focusComposer).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not default to a profile agent that is not available", () => {
    // A retired agent is absent from the available list; "+" must not
    // address new work to it, so the last recipient still applies.
    const retired = agent("retired", "retired");
    expect(composerLaunchRecipient(agents, retired, "mist")?.id).toBe("mist");
    expect(composerLaunchRecipient(agents, retired, null)).toBeUndefined();
  });
});
