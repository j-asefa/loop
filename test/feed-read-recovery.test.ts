import { expect, it, vi } from "vitest";
import { FeedReadRecovery } from "../src/client/feed-read-recovery";
import { setViewOwner } from "../src/client/viewCache";

function controlled() {
  let resolve!: (value: string) => void, reject!: (error: unknown) => void;
  const result = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let signal!: AbortSignal, retry!: (error: unknown) => void;
  return {
    fetch: vi.fn(
      (nextSignal: AbortSignal, onRetry: (error: unknown) => void) => {
        signal = nextSignal;
        retry = onRetry;
        return result;
      },
    ),
    resolve,
    reject,
    result,
    retry: (error: unknown) => retry(error),
    aborted: () => signal.aborted,
  };
}

it("settles a cooling source without blocking healthy reads and requests a fresh head on recovery", async () => {
  const reads = new FeedReadRecovery<string>(),
    slow = controlled(),
    recovered = vi.fn();
  const cooling = reads.read("remote", "head", slow.fetch, recovered);
  const settled = Promise.allSettled([
    cooling,
    reads.read("local", "head", async () => "healthy", recovered),
  ]);
  const error = new Error("cooldown");
  slow.retry(error);
  expect(await settled).toEqual([
    { status: "rejected", reason: error },
    { status: "fulfilled", value: "healthy" },
  ]);
  const duplicate = vi.fn(async () => "unneeded");
  await expect(reads.read("remote", "head", duplicate, recovered)).rejects.toBe(
    error,
  );
  expect(duplicate).not.toHaveBeenCalled();
  await expect(
    reads.read("local", "head", async () => "new healthy", recovered),
  ).resolves.toBe("new healthy");
  slow.resolve("stale recovery page");
  await slow.result;
  expect(recovered).toHaveBeenCalledTimes(1);
  await expect(
    reads.read("remote", "head", async () => "fresh remote", recovered),
  ).resolves.toBe("fresh remote");
});

it("supersedes a normal read without reusing its pre-action snapshot or disturbing another page", async () => {
  const reads = new FeedReadRecovery<string>(),
    old = controlled(),
    olderPage = controlled(),
    recovered = vi.fn();
  const stale = expect(
    reads.read("one", "head", old.fetch, recovered),
  ).rejects.toMatchObject({ name: "AbortError" });
  const page = reads.read("one", "older", olderPage.fetch, recovered);
  await expect(
    reads.read("one", "head", async () => "after action", recovered),
  ).resolves.toBe("after action");
  expect(old.aborted()).toBe(true);
  expect(olderPage.aborted()).toBe(false);
  old.resolve("before action");
  olderPage.resolve("older page");
  await stale;
  await expect(page).resolves.toBe("older page");
  expect(recovered).not.toHaveBeenCalled();
});

it("cancels recovery on source reset and owner replacement even when the transport completes late", async () => {
  setViewOwner("recovery-owner");
  const reads = new FeedReadRecovery<string>(),
    first = controlled(),
    second = controlled(),
    recovered = vi.fn();
  const failed = expect(
    reads.read("one", "head", first.fetch, recovered),
  ).rejects.toThrow("retry");
  first.retry(new Error("retry"));
  await failed;
  const other = expect(
    reads.read("two", "head", second.fetch, recovered),
  ).rejects.toMatchObject({ name: "AbortError" });
  reads.reset("one");
  expect(first.aborted()).toBe(true);
  expect(second.aborted()).toBe(false);
  first.resolve("obsolete source");
  await first.result;
  setViewOwner("replacement-owner");
  await expect(
    reads.read("one", "head", async () => "new owner", recovered),
  ).resolves.toBe("new owner");
  expect(second.aborted()).toBe(true);
  second.resolve("obsolete owner");
  await other;
  expect(recovered).not.toHaveBeenCalled();
  reads.reset();
  setViewOwner(undefined);
});

it("releases exhausted retries without inventing another retry loop", async () => {
  const reads = new FeedReadRecovery<string>(),
    slow = controlled(),
    recovered = vi.fn();
  const failed = expect(
    reads.read("one", "head", slow.fetch, recovered),
  ).rejects.toThrow("unavailable");
  slow.retry(new Error("unavailable"));
  await failed;
  slow.reject(new Error("exhausted"));
  await slow.result.catch(() => {});
  expect(slow.aborted()).toBe(false);
  expect(recovered).not.toHaveBeenCalled();
  await expect(
    reads.read("one", "head", async () => "manual refresh", recovered),
  ).resolves.toBe("manual refresh");
  expect(slow.aborted()).toBe(true);
});

it("notifies the caller when a cooling replay terminates without recovery", async () => {
  const reads = new FeedReadRecovery<string>();
  const replay = controlled(),
    recovered = vi.fn(),
    failedRecovery = vi.fn();
  const failed = expect(
    reads.read("one", "older", replay.fetch, recovered, false, failedRecovery),
  ).rejects.toThrow("cooldown");
  replay.retry(new Error("cooldown"));
  await failed;
  expect(reads.isRecovering("one", "older")).toBe(true);
  expect(failedRecovery).not.toHaveBeenCalled();
  replay.reject(new Error("cursor refused"));
  await replay.result.catch(() => {});
  expect(reads.isRecovering("one", "older")).toBe(false);
  expect(failedRecovery).toHaveBeenCalledTimes(1);
  expect(recovered).not.toHaveBeenCalled();
  reads.reset();
  expect(failedRecovery).toHaveBeenCalledTimes(1);
});

it("a manual page replaces only its recovery and preserves head recovery on both sources", async () => {
  const reads = new FeedReadRecovery<string>();
  const firstHead = controlled(),
    secondHead = controlled(),
    older = controlled();
  const recovered = vi.fn();
  const pending = Promise.allSettled([
    reads.read("first", "head", firstHead.fetch, recovered),
    reads.read("second", "head", secondHead.fetch, recovered),
    reads.read("second", "older", older.fetch, recovered),
  ]);
  for (const read of [firstHead, secondHead, older])
    read.retry(new Error("unavailable"));
  await pending;
  await expect(
    reads.read("second", "older", async () => "manual page", recovered, true),
  ).resolves.toBe("manual page");
  expect(older.aborted()).toBe(true);
  expect(firstHead.aborted()).toBe(false);
  expect(secondHead.aborted()).toBe(false);
  firstHead.resolve("recovered first");
  secondHead.resolve("recovered second");
  older.resolve("obsolete older");
  await Promise.all([firstHead.result, secondHead.result, older.result]);
  expect(recovered).toHaveBeenCalledTimes(2);
  reads.reset();
});

it("pauses only the failed head while an interrupted page recovers", async () => {
  const reads = new FeedReadRecovery<string>(),
    head = controlled(),
    older = controlled(),
    peer = controlled(),
    recovered = vi.fn();
  const failures = Promise.allSettled([
    reads.read("one", "head", head.fetch, recovered),
    reads.read("one", "older", older.fetch, recovered),
    reads.read("two", "head", peer.fetch, recovered),
  ]);
  for (const read of [head, older, peer]) read.retry(new Error("retry"));
  await failures;
  reads.reset("one", "head");
  expect(head.aborted()).toBe(true);
  expect(older.aborted()).toBe(false);
  expect(peer.aborted()).toBe(false);
  head.resolve("obsolete head");
  older.resolve("older page");
  peer.resolve("peer head");
  await Promise.all([head.result, older.result, peer.result]);
  expect(recovered).toHaveBeenCalledTimes(2);
  reads.reset();
});
