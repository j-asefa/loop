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
