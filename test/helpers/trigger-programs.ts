import type Database from "better-sqlite3";

type Instruction = {
  opcode: string;
  p1: number;
  p2: number;
  p3: number;
  p4: string | number | null;
};
type SchemaRoot = { rootpage: number; name: string; tbl_name: string };

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
        .prepare(
          "SELECT rootpage,name,tbl_name FROM sqlite_master WHERE type='index'",
        )
        .all() as SchemaRoot[]
    ).map((row) => [row.rootpage, row]),
  );
  const columns = db.prepare(
    "SELECT name FROM pragma_index_info(?) ORDER BY seqno",
  );
  const cursors = new Map<number, SchemaRoot>();
  const searches: {
    index: string;
    table: string;
    keys: number;
    columns: (string | null)[];
  }[] = [];
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
    ) {
      const index = cursors.get(row.p1)!;
      const keys = Number(row.p4);
      searches.push({
        index: index.name,
        table: index.tbl_name,
        keys,
        columns: (columns.all(index.name) as { name: string | null }[])
          .slice(0, keys)
          .map((column) => column.name),
      });
    }
  }
  return searches;
}

/** Trace instructions delimit trigger statements without rewriting their SQL. */
export function triggerStatements(program: readonly Instruction[]) {
  const statements: Instruction[][] = [];
  let current: Instruction[] | undefined;
  for (const row of program) {
    if (row.opcode === "Trace") {
      current = [];
      statements.push(current);
    }
    current?.push(row);
  }
  return statements;
}

/** Compile all write kinds so every installed trigger on the table is visible. */
export function tableTriggerPrograms(db: Database.Database, table: string) {
  const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
  const columns = (
    db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as {
      name: string;
    }[]
  ).map((column) => quote(column.name));
  if (!columns.length) throw new Error("No columns for trigger table " + table);
  const programs = new Map<string, Instruction[]>();
  for (const sql of [
    `INSERT INTO ${quote(table)} DEFAULT VALUES`,
    `UPDATE ${quote(table)} SET ${columns.map((column) => `${column}=${column}`).join(",")}`,
    `DELETE FROM ${quote(table)}`,
  ])
    for (const [name, program] of triggerPrograms(db, sql))
      programs.set(name, program);
  return programs;
}

/** Find full traversals of main-schema tables or indexes in a trigger program. */
export function triggerFullScans(
  db: Database.Database,
  program: readonly Instruction[],
) {
  const roots = new Map(
    (
      db
        .prepare(
          "SELECT rootpage,name,tbl_name FROM sqlite_master WHERE rootpage>0",
        )
        .all() as SchemaRoot[]
    ).map((row) => [row.rootpage, row]),
  );
  const cursors = new Map<number, SchemaRoot>();
  const scans: { table: string; object: string }[] = [];
  for (const row of program) {
    if (row.opcode === "OpenDup") {
      const prior = cursors.get(row.p2);
      cursors.delete(row.p1);
      if (prior) cursors.set(row.p1, prior);
      continue;
    }
    if (
      row.opcode.startsWith("Open") ||
      ["ReopenIdx", "Close", "SorterOpen"].includes(row.opcode)
    )
      cursors.delete(row.p1);
    if (
      ["OpenRead", "ReopenIdx", "OpenWrite"].includes(row.opcode) &&
      row.p3 === 0
    ) {
      const root = roots.get(row.p2);
      if (root) cursors.set(row.p1, root);
    }
    const root = cursors.get(row.p1);
    if (["Rewind", "Last"].includes(row.opcode) && root)
      scans.push({ table: root.tbl_name, object: root.name });
  }
  return scans;
}
