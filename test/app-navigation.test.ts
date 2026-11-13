import { afterEach, expect, it, vi } from "vitest";
import {
  readAppNavigation,
  replaceConversationLocation,
} from "../src/client/app/Navigation";

const read = (path: string) =>
  readAppNavigation(new URL(path, "https://loop.test"));
afterEach(() => vi.unstubAllGlobals());

it("keeps deep-link precedence and distinguishes an absent folder from an explicit empty folder", () => {
  expect(read("/?page=unknown&filter=unknown")).toMatchObject({
    tab: "feed",
    feedFilter: "done",
    folderChoice: undefined,
  });
  expect(read("/?page=projects&social=entry&folder=project").tab).toBe(
    "profile",
  );
  expect(read("/?page=pulls&folder=project").tab).toBe("pulls");
  expect(read("/?folder=")).toMatchObject({ tab: "profile", folderChoice: "" });
  expect(read("/?memory=1&tools=1&share=1&connect=1").sheet).toBe("memory");
  expect(read("/?tools=1&share=1&connect=1").sheet).toBe("mcp");
});

it("decodes thread, project and share inputs without requiring a browser location", () => {
  expect(
    read(
      "/?page=projects&filter=working&conversation=thread%2Fone&message=reply%20one&source=docker%3Aone&teams=a,,b&projectView=project&pull=owner%2Frepo%2F1&agent=agent&folder=folder",
    ),
  ).toMatchObject({
    tab: "projects",
    feedFilter: "working",
    conversation: "thread/one",
    messageId: "reply one",
    conversationSource: "docker:one",
    teamSelection: ["a", "b"],
    project: "project",
    pull: "owner/repo/1",
    agentId: "agent",
    folderChoice: "folder",
  });
  expect(
    read(
      "/share?text=https%3A%2F%2Fexample.com%2Farticle&title=Title&question=Explain&folder=folder",
    ),
  ).toMatchObject({
    sheet: "share",
    sharedDraft: {
      url: "https://example.com/article",
      title: "Title",
      excerpt: "https://example.com/article",
      question: "Explain",
      folderId: "folder",
    },
  });
  expect(read("/?connect=1")).toMatchObject({
    sheet: "connections",
    returnTo: "create",
  });
  expect(read("/?source=not-a-source").conversationSource).toBe("");
});

it("replaces only the conversation target and retains the page's navigation and history state", () => {
  const url = new URL(
    "https://loop.test/workspace?page=projects&filter=working&folder=p&conversation=old&message=old&source=docker%3Aold#unused",
  );
  const state = { loopShellSource: "docker:shell", loopSheet: true };
  const replaceState = vi.fn();
  vi.stubGlobal("location", url);
  vi.stubGlobal("history", { state, replaceState });
  replaceConversationLocation("docker:one", "thread/one", "reply one");
  const opened = new URL(replaceState.mock.calls[0][2], url.origin);
  expect(Object.fromEntries(opened.searchParams)).toEqual({
    page: "projects",
    filter: "working",
    folder: "p",
    conversation: "thread/one",
    source: "docker:one",
    message: "reply one",
  });
  expect(opened.pathname).toBe("/workspace");
  expect(replaceState.mock.calls[0][0]).toBe(state);
  vi.stubGlobal("location", opened);
  replaceConversationLocation("docker:one", "thread/one");
  expect(
    new URL(replaceState.mock.calls[1][2], url.origin).searchParams.has(
      "message",
    ),
  ).toBe(false);
  replaceConversationLocation("", null);
  const closed = new URL(replaceState.mock.calls[2][2], url.origin);
  expect(Object.fromEntries(closed.searchParams)).toEqual({
    page: "projects",
    filter: "working",
    folder: "p",
  });
  replaceConversationLocation("docker:shell", null);
  expect(
    new URL(replaceState.mock.calls[3][2], url.origin).searchParams.get(
      "source",
    ),
  ).toBe("docker:shell");
});
