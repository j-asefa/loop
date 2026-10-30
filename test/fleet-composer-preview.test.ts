import { expect, it, vi } from "vitest";
import { useComposerSend } from "../src/client/app/Composer";
import { workspaceApi } from "../src/shared/workspace-api";
import { profileCapabilities } from "../src/shared/capabilities";
import { fleetComposerReason } from "../src/client/fleetCapabilities";

const peer = "peer:m_" + "1".repeat(64);
const withoutPreviews = {
  ...profileCapabilities("companion"),
  fleet: {
    version: 1 as const,
    machineId: peer.slice(5),
    reads: [],
    actions: ["submit", "agentCreate"],
    files: false,
    events: false,
  },
};

it.each([
  ["@new Inspect this", "fixture"],
  ["  @NEW Inspect this", "__route__"],
])(
  "opens creation for %s without preview capabilities (%s)",
  async (draft, selected) => {
    const setNewAgentPrompt = vi.fn(),
      setFolder = vi.fn(),
      setSheet = vi.fn(),
      setComposerError = vi.fn(),
      threadApi = vi.fn();
    const send = useComposerSend({
      composerUnavailable: fleetComposerReason(
        peer,
        withoutPreviews,
        draft,
        selected,
      ),
      busy: false,
      uploading: false,
      draft,
      conversation: false,
      projectFilter: "fixture-folder",
      setNewAgentPrompt,
      setFolder,
      setSheet,
      setComposerError,
      threadApi,
    } as unknown as Parameters<typeof useComposerSend>[0]);
    await send();
    expect(setNewAgentPrompt).toHaveBeenCalledWith("Inspect this");
    expect(setFolder).toHaveBeenCalledWith("fixture-folder");
    expect(setSheet).toHaveBeenCalledWith("create");
    expect(setComposerError).not.toHaveBeenCalled();
    expect(threadApi).not.toHaveBeenCalled();
  },
);

it.each([
  ["@fixture Inspect this", "fixture"],
  ["Inspect this", "__route__"],
])("still requires preview access for %s (%s)", (draft, selected) => {
  expect(fleetComposerReason(peer, withoutPreviews, draft, selected)).toContain(
    "does not allow",
  );
});

it("still requires submit access when creating an agent", () => {
  expect(
    fleetComposerReason(
      peer,
      {
        ...withoutPreviews,
        fleet: { ...withoutPreviews.fleet, actions: ["agentCreate"] },
      },
      "@new Inspect this",
      "fixture",
    ),
  ).toContain("does not allow");
});

it.each([
  ["routing", "thread", "resolve"],
  ["routing", "draft", "resolve"],
  ["handle", "thread", "resolve"],
  ["handle", "draft", "resolve"],
  ["routing", "thread", "reject"],
  ["routing", "draft", "reject"],
  ["handle", "thread", "reject"],
  ["handle", "draft", "reject"],
])(
  "drops an unfinished %s preview after the %s changes and the request ends with %s",
  async (kind, change, outcome) => {
    let finish!: (value: unknown) => void;
    let fail!: (error: Error) => void;
    const waiting = new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const threadApi = vi.fn(() => waiting);
    const threadIdentityRef = { current: "original-view" },
      draft = kind === "handle" ? "@fixture inspect" : "Inspect this";
    const draftRef = { current: draft };
    const setRoutePreview = vi.fn(),
      setSheet = vi.fn(),
      setError = vi.fn(),
      setComposerError = vi.fn();
    // Only the pre-dispatch branch is entered. Missing downstream dependencies
    // would report an error, which this regression rejects as well as any IO.
    const send = useComposerSend({
      busy: false,
      uploading: false,
      draft,
      conversation: false,
      conversationTarget: null,
      viewIdentity: "original-view",
      threadIdentityRef,
      threadIdentity: "original-composer",
      composerIdentityRef: { current: "original-composer" },
      draftRef,
      attachmentsRef: { current: [] },
      attachments: [],
      replyContext: null,
      contextArtifact: null,
      threadApi,
      selected: kind === "routing" ? "__route__" : "fixture",
      routePreview: null,
      folder: "",
      setBusy: vi.fn(),
      setRoutePreview,
      setSheet,
      activeAgent: { id: "fixture" },
      ownerRef: { current: "fixture-owner" },
      composerData: { agents: [{ id: "fixture" }], teams: [] },
      teamSelection: [],
      setError,
      setComposerError,
    } as unknown as Parameters<typeof useComposerSend>[0]);
    const pending = send();
    expect(threadApi).toHaveBeenCalledTimes(1);
    expect(threadApi.mock.calls[0]).toEqual(
      kind === "routing"
        ? [
            workspaceApi.routingPreview,
            { body: { input: draft, folderId: undefined } },
          ]
        : [workspaceApi.sharePreview, { body: { question: draft } }],
    );
    if (change === "thread") threadIdentityRef.current = "another-view";
    else draftRef.current = "A different prompt";
    if (outcome === "resolve")
      finish({ agent: { id: "fixture" }, reason: "Fixture recipient" });
    else fail(new Error("Old source is unavailable"));
    await pending;
    expect(threadApi).toHaveBeenCalledTimes(1);
    expect(setRoutePreview).not.toHaveBeenCalled();
    expect(setSheet).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
    expect(setComposerError.mock.calls).toEqual(
      kind === "handle" ? [[""]] : [],
    );
  },
);
