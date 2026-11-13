import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cacheView,
  cachedView,
  setViewOwner,
  viewGeneration,
} from "../src/client/viewCache";
import { saveThreadDraft, threadDraft } from "../src/client/drafts";
import {
  doneReadVersion,
  writeDoneUnreadState,
} from "../src/client/doneReadState";
import {
  beginWorkspaceRead,
  needsWorkspaceReadRecovery,
} from "../src/client/workspace-read-recovery";
import { acquireWorkspacePoll } from "../src/client/workspace-poll-budget";

beforeEach(() => {
  setViewOwner(undefined);
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => {
  setViewOwner(undefined);
  vi.unstubAllGlobals();
});

it("changes draft ownership and transient caches together without deleting durable drafts", async () => {
  setViewOwner("alice");
  const generation = viewGeneration();
  saveThreadDraft("thread", "Alice draft", []);
  cacheView("page", "Alice page", "alice");
  await writeDoneUnreadState("local", async () => ({
    unreadVersions: { card: 4 },
  }));
  const controller = new AbortController();
  beginWorkspaceRead("local", "/feed", controller.signal)(true);
  const late = beginWorkspaceRead("local", "/results", controller.signal);

  setViewOwner("alice");
  expect(viewGeneration()).toBe(generation);
  expect(threadDraft("thread").text).toBe("Alice draft");
  expect(cachedView("page")).toBe("Alice page");
  expect(doneReadVersion("local", "card")).toBe(4);
  expect(needsWorkspaceReadRecovery("local")).toBe(true);

  setViewOwner("bob");
  expect(viewGeneration()).not.toBe(generation);
  expect(threadDraft("thread").text).toBe("");
  expect(cachedView("page")).toBeUndefined();
  expect(doneReadVersion("local", "card")).toBe(0);
  expect(needsWorkspaceReadRecovery("local")).toBe(false);
  late(true);
  expect(needsWorkspaceReadRecovery("local")).toBe(false);
  saveThreadDraft("thread", "Bob draft", []);

  setViewOwner(undefined);
  expect(threadDraft("thread").text).toBe("");
  saveThreadDraft("thread", "Signed-out write", []);
  setViewOwner("alice");
  expect(threadDraft("thread").text).toBe("Alice draft");
  expect(cachedView("page")).toBeUndefined();
  expect(doneReadVersion("local", "card")).toBe(0);
  late(true);
  expect(needsWorkspaceReadRecovery("local")).toBe(false);
  setViewOwner("bob");
  expect(threadDraft("thread").text).toBe("Bob draft");
  controller.abort();
});

it("keeps late poll releases and unread responses out of a returning owner's state", async () => {
  setViewOwner("alice");
  const releaseOld = acquireWorkspacePoll(Symbol());
  expect(releaseOld).toBeTypeOf("function");
  let finish!: (value: { unreadVersions: Record<string, number> }) => void;
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  const write = writeDoneUnreadState("local", () => {
    started();
    return new Promise<{ unreadVersions: Record<string, number> }>(
      (resolve) => {
        finish = resolve;
      },
    );
  });
  await dispatched;
  setViewOwner(undefined);
  setViewOwner("alice");
  const releases = Array.from({ length: 4 }, () =>
    acquireWorkspacePoll(Symbol()),
  );
  expect(releases.every((release) => typeof release === "function")).toBe(true);
  releaseOld!();
  const waiting = Symbol();
  expect(acquireWorkspacePoll(waiting)).toBeUndefined();
  releases[0]!();
  const releaseNext = acquireWorkspacePoll(waiting);
  expect(releaseNext).toBeTypeOf("function");
  finish({ unreadVersions: { card: 99 } });
  await write;
  expect(doneReadVersion("local", "card")).toBe(0);
  releases.slice(1).forEach((release) => release!());
  releaseNext!();
});
