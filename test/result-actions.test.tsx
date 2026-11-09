import { afterEach, expect, it, vi } from "vitest";
import { renderResults } from "../src/client/app/Results";
import { resultAction } from "../src/client/card-actions";
import type { ResultCard } from "../src/shared/cards";
import { workspaceApi } from "../src/shared/workspace-api";
import { callRoute } from "../src/client/workspace-api";

vi.mock("../src/client/workspace-api", () => ({ callRoute: vi.fn() }));
vi.mock("../src/client/sourceRouting", async (original) => ({
  ...(await original<object>()),
  executionSourceId: () => "remote",
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const card: ResultCard = {
  id: "a:result",
  type: "result",
  title: "Answer",
  kind: "markdown",
  content: "Stored answer",
  source: {
    artifact_id: "result",
    agent_id: "agent",
    message_id: "message",
    conversation_id: "thread",
    run_id: "run",
  },
  author: { kind: "agent", id: "agent", name: "Writer", provider: null },
  recipient: null,
  context: {
    conversation_title: "Thread",
    folder_id: null,
    project_id: null,
    project_name: null,
    team_id: null,
  },
  format: "markdown",
  created_at: 1,
  updated_at: null,
  saved: false,
  attachments: [],
  href: "/?artifact=result",
  version: 7,
  hidden: false,
  display: {
    model: null,
    tool: null,
    partial: false,
    imported: false,
    uploaded: false,
    mime: null,
    filename: null,
    size: null,
    text: false,
    download: null,
    source: null,
    refreshable: false,
    app: false,
  },
};
function fixture() {
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  const props = {
    beginReply: vi.fn(),
    setConversation: vi.fn(),
    open: vi.fn(),
    replyToArtifact: vi.fn(),
    archiveCard: vi.fn(),
    setLaterCard: vi.fn(),
    setFiling: vi.fn(),
    setProfile: vi.fn(),
    ownerRef: { current: "owner" },
    changed: vi.fn(),
    setError: vi.fn(),
    openCard: vi.fn(),
    data: { agents: [], connections: [], folders: [] },
    resultsError: "",
    items: [],
    loadResults: vi.fn(),
    resultsLoading: false,
    profile: null,
    view: "all",
    projectFilter: "",
    teamSelection: [],
    profileWork: [],
    next: null,
  } as unknown as Parameters<typeof renderResults>[0];
  return { props, render: renderResults(props).resultCard };
}
it.each([false, true])(
  "saves a typed result using its source, stored version and saved state (%s)",
  async (saved) => {
    const { props, render } = fixture();
    const item = resultAction({ ...card, saved }, "remote", "owner");
    const element = render(item);
    await element.props.onSave();
    expect(callRoute).toHaveBeenCalledWith(
      workspaceApi.artifactUpdate,
      {
        params: { id: "result" },
        body: { pinned: !saved, version: 7 },
      },
      "remote",
    );
    expect(props.changed).toHaveBeenCalledOnce();
    element.props.onArchive();
    expect(props.archiveCard).toHaveBeenCalledWith("result", true, "remote");
    element.props.onReply();
    expect(props.replyToArtifact).toHaveBeenCalledWith(item);
    element.props.onFile();
    expect(props.setFiling).toHaveBeenCalledWith(item);
  },
);
it("does not save a card retained from another owner", async () => {
  const { render } = fixture();
  await render(resultAction(card, "remote", "earlier-owner")).props.onSave();
  expect(callRoute).not.toHaveBeenCalled();
});
it("keeps Saved's delayed undo path when unsaving a typed result", async () => {
  const { render } = fixture();
  const unsave = vi.fn();
  await render(
    resultAction({ ...card, saved: true }, "remote", "owner"),
    true,
    unsave,
  ).props.onSave();
  expect(unsave).toHaveBeenCalledOnce();
  expect(callRoute).not.toHaveBeenCalled();
});
