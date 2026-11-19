// Replay evaluation for memory recall: a proxy measure of retrieval and
// excerpt quality on a copy of a workspace database. It calls production
// searchMemory and evidenceBlock; it never reimplements them.
//
//   mkdir -m 700 /var/tmp/memory-eval/pristine /var/tmp/memory-eval/base /var/tmp/memory-eval/head
//   LOOP_DATA_DIR=/var/tmp/memory-eval/pristine node --import tsx scripts/memory-recall-eval.ts \
//     --copy-from <workspace loop.db> --copy-only
//   # then, from each build's checkout, a fresh copy of the same snapshot:
//   LOOP_DATA_DIR=/var/tmp/memory-eval/base node --import tsx scripts/memory-recall-eval.ts \
//     --copy-from /var/tmp/memory-eval/pristine/loop.db --json /var/tmp/memory-eval/base.json
//   node --import tsx scripts/memory-recall-eval.ts --compare base.json head.json
//
// It writes only to a private directory it filled with --copy-from. Each run
// captures memory into its copy, so give each build its own copy of one
// pristine snapshot. The data stays local: share aggregates only.
import {
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

/** Characters of a source that the pre-passage excerpt showed. */
export const HEAD_CHARACTERS = 1100;
const EVIDENCE_BLOCK =
  /<loop-historical-evidence[\s\S]*?<\/loop-historical-evidence>/g;

export type EvalQuery = {
  set: "known" | "null";
  owner: string;
  project: string | null;
  query: string;
  /** Memory source the query should recall (known-item queries). */
  target?: string;
  /** Target text is beyond the head: its terms meet only after HEAD_CHARACTERS. */
  deep?: boolean;
  /** Share of the query's distinct terms the target contains. */
  targetCoverage?: number;
  /**
   * Conversation whose sources the search skips, as recall does. Known-item
   * queries have none: they ask again as if from a new conversation, so the
   * result's own conversation is not excluded.
   */
  conversation?: string;
};

export type EvalMetrics = {
  known: number;
  deep: number;
  null: number;
  skipped: number;
  hit1: number;
  hit5: number;
  mrr5: number;
  abstainKnown: number;
  abstainNull: number;
  excerptCoverage: number;
  deepHit5: number;
  deepCoverage: number;
  misses5: number;
  vocabMisses5: number;
  vocabMissShare: number;
  injectedMean: number;
  injectedP95: number;
  latencyP95Ms: number;
};

type Memory = typeof import("../src/server/memory.js");

/** Deterministic PRNG so base and head runs sample the same queries. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function sample<T>(items: T[], limit: number, seed: number) {
  const random = mulberry32(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, limit);
}
const prompt = (input: string) => input.replace(EVIDENCE_BLOCK, "").trim();
const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const p95 = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  ];
};
const share = (part: number, whole: number) => (whole ? part / whole : 0);

/**
 * Known-item and null query sets from the database the server modules opened.
 * Queries without searchable terms are counted as skipped.
 */
export async function sampleQueries({
  seed = 1,
  limit = 500,
}: { seed?: number; limit?: number } = {}) {
  const { db } = await import("../src/server/db.js");
  const memorySources = await import("../src/server/sql/memory-sources.js");
  const { coversQuery, enabled, matchedTerms, recallTerms, recallable } =
    (await import("../src/server/memory.js")) as Memory;
  const { hasEarlierCompletedConversationRun } =
    await import("../src/server/sql/runs.js");
  const recallEnabled = (owner: string, project: string | null) =>
    enabled(owner, "workspace") &&
    (!project || enabled(owner, "project:" + project));
  let skipped = 0;
  const known: EvalQuery[] = [];
  // Only results recall may return now: a source the owner's memory policy
  // excludes is not a retrieval miss.
  const items = memorySources
    .knownItems(db)
    .filter(
      (item) =>
        recallEnabled(item.owner_id, item.project_id) &&
        recallable(item.owner_id, item.id),
    );
  for (const item of sample(items, limit, seed)) {
    const query = prompt(item.input);
    const terms = recallTerms(query);
    if (!terms.length) {
      skipped++;
      continue;
    }
    known.push({
      set: "known",
      owner: item.owner_id,
      project: item.project_id,
      query,
      target: item.id,
      // Deep known items measure where the terms co-occur in the document body.
      deep:
        coversQuery(item.content, terms) &&
        !coversQuery(item.content.slice(0, HEAD_CHARACTERS), terms),
      targetCoverage:
        matchedTerms(item.title + "\n" + item.content, terms) / terms.length,
    });
  }
  const none: EvalQuery[] = [];
  for (const item of sample(
    memorySources
      .promptsWithoutSources(db)
      .filter(
        (item) =>
          recallEnabled(item.owner_id, item.project_id) &&
          !hasEarlierCompletedConversationRun(
            db,
            item.conversation_id,
            item.run_id,
          ),
      ),
    limit,
    seed,
  )) {
    const query = prompt(item.input);
    if (!recallTerms(query).length) {
      skipped++;
      continue;
    }
    none.push({
      set: "null",
      owner: item.owner_id,
      project: item.project_id,
      query,
      conversation: item.conversation_id,
    });
  }
  return { queries: [...known, ...none], skipped };
}

/** Runs every query through production recall and aggregates the results. */
export async function evaluate(
  queries: EvalQuery[],
  { skipped = 0, warmup = 10 }: { skipped?: number; warmup?: number } = {},
): Promise<EvalMetrics> {
  const { searchMemory, evidenceBlock, matchedTerms, recallTerms } =
    (await import("../src/server/memory.js")) as Memory;
  const search = (q: EvalQuery) =>
    searchMemory(q.owner, q.project, q.query, {
      relevant: true,
      ...(q.conversation === undefined ? {} : { conversation: q.conversation }),
    });
  for (const q of queries.slice(0, warmup)) await search(q);
  const latencies: number[] = [];
  const injected: number[] = [];
  const known = {
    n: 0,
    hit1: 0,
    hit5: 0,
    rr: 0,
    abstain: 0,
    coverage: [] as number[],
  };
  const deep = { n: 0, hit5: 0, coverage: [] as number[] };
  let nulls = 0,
    abstainNull = 0,
    misses = 0,
    vocabMisses = 0;
  for (const q of queries) {
    const started = performance.now();
    const found = await search(q);
    latencies.push(performance.now() - started);
    // Score what the turn would receive: the evidence block drops sources
    // that would take it past its character budget.
    const { text, included: sources } = evidenceBlock(found.sources);
    injected.push(text.length);
    if (q.set === "null") {
      nulls++;
      if (!sources.length) abstainNull++;
      continue;
    }
    known.n++;
    if (q.deep) deep.n++;
    if (!sources.length) known.abstain++;
    const rank = sources.slice(0, 5).findIndex((s) => s.id === q.target);
    if (rank < 0) {
      misses++;
      if ((q.targetCoverage ?? 0) < 0.25) vocabMisses++;
      continue;
    }
    if (rank === 0) known.hit1++;
    known.hit5++;
    known.rr += 1 / (rank + 1);
    const terms = recallTerms(q.query);
    const coverage = matchedTerms(sources[rank].excerpt, terms) / terms.length;
    known.coverage.push(coverage);
    if (q.deep) {
      deep.hit5++;
      deep.coverage.push(coverage);
    }
  }
  return {
    known: known.n,
    deep: deep.n,
    null: nulls,
    skipped,
    hit1: share(known.hit1, known.n),
    hit5: share(known.hit5, known.n),
    mrr5: share(known.rr, known.n),
    abstainKnown: share(known.abstain, known.n),
    abstainNull: share(abstainNull, nulls),
    excerptCoverage: mean(known.coverage),
    deepHit5: share(deep.hit5, deep.n),
    deepCoverage: mean(deep.coverage),
    misses5: misses,
    vocabMisses5: vocabMisses,
    vocabMissShare: share(vocabMisses, misses),
    injectedMean: mean(injected),
    injectedP95: p95(injected),
    latencyP95Ms: p95(latencies),
  };
}

const ROWS: [keyof EvalMetrics, string, "count" | "share" | "number"][] = [
  ["known", "known-item queries", "count"],
  ["deep", "deep known-item queries", "count"],
  ["null", "null queries", "count"],
  ["skipped", "skipped (no search terms)", "count"],
  ["hit1", "hit@1", "share"],
  ["hit5", "hit@5", "share"],
  ["mrr5", "MRR@5", "number"],
  ["abstainKnown", "abstain (known-item, wrong)", "share"],
  ["abstainNull", "abstain (null)", "share"],
  ["excerptCoverage", "excerpt coverage (hits)", "share"],
  ["deepHit5", "deep hit@5", "share"],
  ["deepCoverage", "deep excerpt coverage", "share"],
  ["misses5", "misses at k=5", "count"],
  ["vocabMisses5", "vocabulary misses at k=5", "count"],
  ["vocabMissShare", "vocab miss share", "share"],
  ["injectedMean", "injected chars (mean)", "number"],
  ["injectedP95", "injected chars (p95)", "number"],
  ["latencyP95Ms", "search p95 (ms)", "number"],
];
const cell = (value: number, kind: string) =>
  kind === "share"
    ? (value * 100).toFixed(1) + "%"
    : kind === "count"
      ? String(value)
      : value.toFixed(value < 10 ? 3 : 0);

/** A Markdown table with one column per labelled run. */
export function table(runs: [string, EvalMetrics][]) {
  return [
    `| Metric | ${runs.map(([label]) => label).join(" | ")} |`,
    `| --- | ${runs.map(() => "---").join(" | ")} |`,
    ...ROWS.map(
      ([key, label, kind]) =>
        `| ${label} | ${runs.map(([, m]) => cell(m[key], kind)).join(" | ")} |`,
    ),
  ].join("\n");
}

// What recall reads, in foreign-key order. Connections (credentials) and
// review snapshots are never copied.
const COPIED_TABLES = [
  "folders",
  "agents",
  "conversations",
  "runs",
  "messages",
  "artifacts",
  "artifact_publications",
  "agent_checkpoints",
  "results",
  "memory_policy",
  "memory_sources",
  "memory_note_versions",
];
/**
 * Copies the tables recall reads from a workspace database, opened read-only,
 * into the freshly migrated database the server modules opened. A full backup
 * of a large workspace (mostly review snapshots) takes hours; this takes
 * seconds. Columns the two schemas share are copied; triggers rebuild indexes.
 */
async function copyFrom(path: string) {
  const { db } = await import("../src/server/db.js");
  const { default: Database } = await import("better-sqlite3");
  const source = new Database(path, { readonly: true, fileMustExist: true });
  // One read transaction: every table comes from the same snapshot.
  source.exec("BEGIN");
  const columns = (database: typeof db, table: string) =>
    (database.pragma(`table_info(${table})`) as { name: string }[]).map(
      (c) => c.name,
    );
  db.pragma("foreign_keys = OFF");
  // Other tables' triggers maintain feed and conversation projections recall
  // never reads, and make a bulk copy take hours; memory's own triggers stay.
  const triggers = (
    db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name NOT LIKE 'memory%'",
      )
      .all() as { name: string; sql: string }[]
  ).filter((t) => COPIED_TABLES.some((table) => t.sql.includes(table)));
  for (const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
  const copied: Record<string, number> = {};
  try {
    db.transaction(() => {
      for (const table of COPIED_TABLES) {
        const target = new Set(columns(db, table));
        const shared = columns(source, table).filter((c) => target.has(c));
        if (!shared.length) continue;
        const list = shared.map((c) => `"${c}"`).join(",");
        const insert = db.prepare(
          `INSERT OR REPLACE INTO ${table}(${list}) VALUES(${shared.map(() => "?").join(",")})`,
        );
        let rows = 0;
        for (const row of source
          .prepare(`SELECT ${list} FROM ${table}`)
          .raw()
          .iterate())
          (insert.run(row as unknown[]), rows++);
        copied[table] = rows;
        console.error(`copied ${table}: ${rows}`);
      }
    })();
  } finally {
    for (const t of triggers) db.exec(t.sql);
    db.pragma("foreign_keys = ON");
    source.exec("COMMIT");
    source.close();
  }
  return copied;
}

/** Captures memory until a pass changes nothing, as an upgrade would. */
async function catchUp() {
  const { db } = await import("../src/server/db.js");
  const { captureMemory } = (await import("../src/server/memory.js")) as Memory;
  const { captureProgress } =
    await import("../src/server/sql/memory-sources.js");
  let previous = JSON.stringify(captureProgress(db));
  for (let pass = 1; pass <= 1000; pass++) {
    captureMemory();
    const progress = JSON.stringify(captureProgress(db));
    if (progress === previous) return pass;
    previous = progress;
  }
  throw new Error("Memory capture did not settle in 1,000 passes.");
}
// Written by --copy-from; a data directory without it is never written to.
const COPY_MARKER = "memory-eval-copy";

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

type EvalReport = EvalMetrics & { queryFingerprint: string };

export function queryFingerprint(queries: EvalQuery[]) {
  return createHash("sha256").update(JSON.stringify(queries)).digest("hex");
}

export async function main(args: string[]) {
  const compare = option(args, "--compare");
  if (compare) {
    const files = args.slice(args.indexOf("--compare") + 1);
    const reports = files.map(
      (file) => JSON.parse(readFileSync(file, "utf8")) as EvalReport,
    );
    if (
      reports.length < 2 ||
      !reports[0].queryFingerprint ||
      reports.some(
        (report) => report.queryFingerprint !== reports[0].queryFingerprint,
      )
    ) {
      throw new Error(
        "Comparison requires reports from the same sampled queries.",
      );
    }
    console.log(
      table(
        reports.map((report, i) => [
          i === 0 ? "base" : reports.length === 2 ? "head" : files[i],
          report,
        ]),
      ),
    );
    return;
  }
  const data = process.env.LOOP_DATA_DIR;
  // Capture writes to the database it opens: only ever a copy this script
  // built, in a private directory it started empty.
  if (!data || !existsSync(data))
    throw new Error("Set LOOP_DATA_DIR to an existing, empty directory.");
  if (statSync(data).mode & 0o077)
    throw new Error(
      "LOOP_DATA_DIR must be private (mkdir -m 700): the copy holds the owner's work.",
    );
  const from = option(args, "--copy-from");
  const marker = resolve(data, COPY_MARKER);
  if (from) {
    if (readdirSync(data).length)
      throw new Error("--copy-from needs an empty LOOP_DATA_DIR.");
    console.log("copied rows:", await copyFrom(from));
    // Only a finished copy is trusted by later runs.
    writeFileSync(marker, realpathSync(from) + "\n");
    if (args.includes("--copy-only")) return;
  } else if (!existsSync(marker))
    throw new Error(
      "LOOP_DATA_DIR was not built by --copy-from; refusing to write to it.",
    );
  const passes = await catchUp();
  const { queries, skipped } = await sampleQueries({
    seed: Number(option(args, "--seed") ?? 1),
    limit: Number(option(args, "--limit") ?? 500),
  });
  const metrics = await evaluate(queries, { skipped });
  const out = option(args, "--json");
  if (out) {
    const report: EvalReport = {
      ...metrics,
      queryFingerprint: queryFingerprint(queries),
    };
    writeFileSync(out, JSON.stringify(report, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
  }
  console.log(`capture passes: ${passes}\n`);
  console.log(table([["this build", metrics]]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
