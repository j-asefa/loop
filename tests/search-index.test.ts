import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const fixture = vi.hoisted(() => ({ fail: false, stall: false, calls: 0 }));
vi.mock("../src/server/local-embeddings.js", () => ({
  localModel: "local:all-MiniLM-L6-v2:q8",
  localEmbeddings: async (texts: string[]) => {
    fixture.calls++;
    if (fixture.fail) throw new Error("Do not expose fixture credentials");
    if (fixture.stall) return new Promise(() => {});
    return texts.map((text) => (/car|automobile/.test(text) ? [1, 0] : [0, 1]));
  },
}));
const dir = mkdtempSync(join(tmpdir(), "loop-search-index-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { saveArtifact } = await import("../src/server/artifacts");
const { indexPending, search, searchStatus } =
  await import("../src/server/search");
let clock = Date.now();
vi.spyOn(Date, "now").mockImplementation(() => clock);
const advance = (ms = 6000) => (clock += ms);
const enable = (owner: string) =>
  db
    .prepare(
      "INSERT INTO preferences VALUES(?,NULL,'local:all-MiniLM-L6-v2:q8',1)",
    )
    .run(owner);
afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("reports initial preparation, indexes batches and title-only files, and ignores entirely blank records", async () => {
  const owner = id();
  for (let i = 0; i < 18; i++)
    saveArtifact(owner, {
      title: "Travel " + i,
      content: "A car is parked outside.",
    });
  saveArtifact(owner, {
    title: "Vehicle registration.pdf",
    content: "",
    kind: "file",
  });
  saveArtifact(owner, { title: "", content: "" });
  enable(owner);
  expect(searchStatus(owner)).toMatchObject({
    state: "preparing",
    total: 19,
    pending: 19,
    indexed: 0,
  });
  const initial = await search(owner, "automobile");
  expect(initial.mode).toBe("keyword");
  expect(initial.detail).toContain("Preparing semantic search");
  expect(fixture.calls).toBe(0);
  advance();
  await indexPending();
  expect(searchStatus(owner)).toMatchObject({
    state: "indexing",
    indexed: 16,
    pending: 3,
  });
  advance();
  await indexPending();
  expect(searchStatus(owner)).toMatchObject({
    state: "ready",
    indexed: 19,
    pending: 0,
  });
  const result = await search(owner, "automobile");
  expect(result).toMatchObject({ mode: "hybrid", pending: 0 });
  expect(result.items).toHaveLength(18);
  expect(searchStatus("stranger")).toMatchObject({
    enabled: false,
    indexed: 0,
  });
  const file = db
    .prepare("SELECT id FROM artifacts WHERE owner_id=? AND kind='file'")
    .get(owner) as any;
  db.prepare(
    "UPDATE artifacts SET title='Updated registration.pdf',updated_at=? WHERE id=?",
  ).run(now(), file.id);
  expect(searchStatus(owner)).toMatchObject({
    state: "indexing",
    indexed: 18,
    pending: 1,
  });
  db.prepare("UPDATE preferences SET embedding_enabled=0 WHERE owner_id=?").run(
    owner,
  );
});

it("returns the matching passage through the search service", async () => {
  const owner = id();
  const artifact = saveArtifact(owner, {
    title: "Integration report",
    content:
      "# Integration report\n\n" +
      "Background context. ".repeat(40) +
      "Use web_fetch_exa to retrieve the release notes.",
  });
  const result = await search(owner, "web_fetch_exa");
  expect(
    result.items.find((item) => item.id === "artifact:" + artifact)?.snippet,
  ).toContain("web_fetch_exa");
  expect(result.items[0].snippet).not.toContain("Integration report");
});

it("exposes a sanitized indexing failure, keeps keyword results, and recovers on a later retry", async () => {
  const owner = id();
  saveArtifact(owner, {
    title: "Travel planning",
    content: "A car is parked outside.",
  });
  enable(owner);
  fixture.fail = true;
  advance();
  await indexPending();
  expect(searchStatus(owner)).toMatchObject({
    state: "error",
    indexed: 0,
    pending: 1,
  });
  expect(searchStatus(owner).detail).not.toContain("credentials");
  const result = await search(owner, "Travel");
  expect(result.items).toHaveLength(1);
  expect(result.detail).toContain("indexing failed");
  const calls = fixture.calls;
  advance();
  await indexPending();
  expect(fixture.calls).toBe(calls);
  fixture.fail = false;
  advance(31000);
  await indexPending();
  expect(searchStatus(owner)).toMatchObject({
    state: "ready",
    indexed: 1,
    pending: 0,
  });
  expect((await search(owner, "automobile")).items).toHaveLength(1);
  fixture.stall = true;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const stalled = search(owner, "Travel");
    await vi.advanceTimersByTimeAsync(4001);
    const fallback = await stalled;
    expect(fallback.mode).toBe("keyword");
    expect(fallback.items).toHaveLength(1);
    expect(fallback.detail).toContain("unavailable");
  } finally {
    fixture.stall = false;
    vi.useRealTimers();
  }
});
