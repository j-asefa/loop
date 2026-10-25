// The correctness oracle for the Feed storage work: every Feed and results
// display response over a fixed workspace, compared with committed snapshots.
// Projection clocks/delta envelopes are validated separately from this content
// oracle because epochs and owner watermarks are transport metadata. Run
// with UPDATE_SNAPSHOTS=1 to record display snapshots (and statements.json, the SQL
// statement count per request, which is informational).
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createFeedFixture,
  NOW,
  OWNER,
  resetStatements,
  statements,
} from "./helpers/feed-fixture";
import { productionApp } from "./helpers/app";

const update = process.env.UPDATE_SNAPSHOTS === "1";
const folder = join(import.meta.dirname, "snapshots", "feed");
const counts: Record<string, number> = {};
let fixture: Awaited<ReturnType<typeof createFeedFixture>>;
let app: Awaited<ReturnType<typeof productionApp>>;

beforeAll(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  fixture = await createFeedFixture();
  app = await productionApp(OWNER);
});
afterAll(async () => {
  await app.close();
  fixture.close();
  vi.restoreAllMocks();
  const file = join(folder, "statements.json");
  if (update) writeFileSync(file, JSON.stringify(counts, null, 2) + "\n");
  else if (existsSync(file)) {
    const before = JSON.parse(readFileSync(file, "utf8"));
    for (const [name, count] of Object.entries(counts))
      if (before[name] !== count)
        console.info(`statements ${name}: ${before[name]} → ${count}`);
  }
});

const filters = ["all", "done", "needs", "working", "queued", "later", "outcomes", "unfinished"];
const scopes: Record<string, string> = {
  none: "",
  folder: "&folder=proj",
  agent: "&agent=agent-api",
  team: "&teams=team-1",
};
// Request paths for each snapshot. The thread list and the results stream
// are named by what they are, so renaming their routes keeps the snapshots.
const feedPath = "/api/feed";
const resultsPath = "/api/results";
const cases: [string, string][] = [
  ...filters.flatMap((filter) =>
    Object.entries(scopes).map(
      ([scope, query]): [string, string] => [
        `feed-${filter}-${scope}`,
        `${feedPath}?filter=${filter}${filter === "done" ? "&expand=results" : ""}${query}`,
      ],
    ),
  ),
  ["feed-away", `${feedPath}/away?since=0`],
  ["results-all", `${resultsPath}?view=all`],
  ["results-prompts", `${resultsPath}?view=prompts`],
  ["results-files", `${resultsPath}?view=files`],
  ["results-saved", `${resultsPath}?saved=1`],
  ["results-updates", `${resultsPath}/updates?after=0&through=0`],
];

it.each(cases)("%s matches its snapshot", async (name, path) => {
  resetStatements();
  const response = await app.fetch(path);
  counts[name] = statements();
  const { projection, projectionRows, ...content } = await response.json();
  if (path !== "/api/feed/away?since=0") {
    expect(projection).toMatchObject({
      epoch: expect.any(String),
      cursor: expect.any(Number),
      serverNow: expect.any(Number),
    });
    expect(projection.cursor).toBeGreaterThanOrEqual(0);
  }
  if (projectionRows) {
    expect(projectionRows.delta).toBe(false);
    expect(projectionRows.entities.map((row: any) => row.id)).toEqual(
      content.items.map((row: any) =>
        JSON.stringify([row.conversation_id, row.done_card_key ?? null]),
      ),
    );
    for (const row of projectionRows.entities) {
      expect(row.signature).toMatch(/^[a-f0-9]{32}$/);
      expect(row.revision).toBeGreaterThanOrEqual(0);
      expect(row.revision).toBeLessThanOrEqual(projection.cursor);
    }
  }
  const body = { status: response.status, body: content };
  const file = join(folder, `${name}.json`);
  if (update) writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
  expect(body).toEqual(JSON.parse(readFileSync(file, "utf8")));
});
