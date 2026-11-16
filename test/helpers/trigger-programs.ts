import type Database from "better-sqlite3";

type Instruction = {
  opcode: string;
  p1: number;
  p2: number;
  p3: number;
  p4: string | number | null;
};

/** Compile the actual write and its installed triggers without executing it. */
export function triggerPrograms(
  db: Database.Database,
  sql: string,
  ...bindings: unknown[]
) {
  const programs = new Map<string, Instruction[]>();
  let current: Instruction[] | undefined;
  for (const row of db
    .prepare("EXPLAIN " + sql)
    .all(...bindings) as Instruction[]) {
    if (row.opcode === "Init") {
      current = undefined;
      if (typeof row.p4 === "string" && row.p4.startsWith("-- TRIGGER ")) {
        current = [];
        programs.set(row.p4.slice("-- TRIGGER ".length), current);
      }
    }
    current?.push(row);
  }
  return programs;
}

/** Record index seek prefixes from SQLite's compiled trigger instructions. */
export function triggerIndexSearches(
  db: Database.Database,
  program: readonly Instruction[],
) {
  const indexes = new Map(
    (
      db
        .prepare("SELECT rootpage,name FROM sqlite_master WHERE type='index'")
        .all() as { rootpage: number; name: string }[]
    ).map((row) => [row.rootpage, row.name]),
  );
  const cursors = new Map<number, string>();
  const searches: { index: string; keys: number }[] = [];
  for (const row of program) {
    if (
      row.opcode.startsWith("Open") ||
      ["ReopenIdx", "Close", "SorterOpen"].includes(row.opcode)
    )
      cursors.delete(row.p1);
    if (row.opcode === "OpenRead" || row.opcode === "ReopenIdx") {
      const index = row.p3 === 0 ? indexes.get(row.p2) : undefined;
      if (index) cursors.set(row.p1, index);
    }
    if (
      ["SeekGE", "SeekGT", "SeekLE", "SeekLT"].includes(row.opcode) &&
      cursors.has(row.p1)
    )
      searches.push({ index: cursors.get(row.p1)!, keys: Number(row.p4) });
  }
  return searches;
}
