import { expect, it } from "vitest";
import { contractDoneThreadReader } from "../src/shared/done-thread-client.js";
import { workspaceApi } from "../src/shared/workspace-api.js";

it("stops paging after source lifetime cancellation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const reader = contractDoneThreadReader(async () => {
    calls++;
    controller.abort(new Error("Source changed"));
    return { threads: [], next: "next-page" };
  });
  await expect(reader.list({}, controller.signal)).rejects.toThrow(
    "Source changed",
  );
  expect(calls).toBe(1);
});

it("rejects a repeated continuation instead of looping on a peer", async () => {
  let calls = 0;
  const reader = contractDoneThreadReader(async () => {
    calls++;
    return { threads: [], next: "same-page" };
  });
  await expect(reader.list()).rejects.toThrow("pagination did not advance");
  expect(calls).toBe(2);
});

it("uses the older route only when the initial page endpoint is absent", async () => {
  const calls: string[] = [];
  const reader = contractDoneThreadReader(async (contract) => {
    calls.push(contract.path);
    if (contract === workspaceApi.doneThreadListPage)
      throw Object.assign(new Error("Not found"), { status: 404 });
    return [];
  });
  expect(await reader.list()).toEqual([]);
  expect(calls).toEqual([
    workspaceApi.doneThreadListPage.path,
    workspaceApi.doneThreadList.path,
  ]);
  calls.length = 0;
  const interrupted = contractDoneThreadReader(async (contract) => {
    calls.push(contract.path);
    if (calls.length === 1) return { threads: [], next: "next-page" };
    throw Object.assign(new Error("Source removed"), { status: 404 });
  });
  await expect(interrupted.list()).rejects.toThrow("Source removed");
  expect(calls).toEqual([
    workspaceApi.doneThreadListPage.path,
    workspaceApi.doneThreadListPage.path,
  ]);
});

it("refuses a detail page for another group", async () => {
  const reader = contractDoneThreadReader(async () => ({
    thread: { id: "other", title: "Other", createdAt: 1, cardIds: [] },
    cards: [],
    next: null,
  }));
  await expect(reader.detail("requested")).rejects.toThrow(
    "membership changed",
  );
});

it("explains a page size refusal for both list and detail readers", async () => {
  const reader = contractDoneThreadReader(async () => {
    throw Object.assign(
      new Error("The remote workspace item is unavailable."),
      {
        status: 413,
      },
    );
  });
  await expect(reader.list()).rejects.toThrow("Open its original conversation");
  await expect(reader.detail("requested")).rejects.toThrow(
    "Open its original conversation",
  );
});

it("uses the older detail endpoint only before any page was accepted", async () => {
  const detail = {
    thread: { id: "requested", title: "Group", createdAt: 1, cardIds: [] },
    cards: [],
  };
  const calls: string[] = [];
  const reader = contractDoneThreadReader(async (contract) => {
    calls.push(contract.path);
    if (contract === workspaceApi.doneThreadDetailPage)
      throw Object.assign(new Error("Not found"), { status: 404 });
    return detail;
  });
  expect(await reader.detail("requested")).toEqual(detail);
  expect(calls).toEqual([
    workspaceApi.doneThreadDetailPage.path,
    workspaceApi.doneThreadDetail.path,
  ]);
  calls.length = 0;
  const interrupted = contractDoneThreadReader(async (contract) => {
    calls.push(contract.path);
    if (calls.length === 1) return { ...detail, next: "next-page" };
    throw Object.assign(new Error("Source removed"), { status: 404 });
  });
  await expect(interrupted.detail("requested")).rejects.toThrow(
    "Source removed",
  );
  expect(calls).toEqual([
    workspaceApi.doneThreadDetailPage.path,
    workspaceApi.doneThreadDetailPage.path,
  ]);
});

it("rejects a completed multi-page detail missing a declared member", async () => {
  let calls = 0;
  const reader = contractDoneThreadReader(async () => ({
    thread: {
      id: "requested",
      title: "Group",
      createdAt: 1,
      cardIds: ["d:run:missing"],
    },
    cards: [],
    next: ++calls === 1 ? "next-page" : null,
  }));
  await expect(reader.detail("requested")).rejects.toThrow(
    "omitted or repeated a member",
  );
  expect(calls).toBe(2);
});
