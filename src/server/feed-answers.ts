// Match String.trim() for answer eligibility; SQLite's default trim only
// removes spaces, leaving newline/tab-only output visible as blank cards.
// Migration 102 indexes this predicate; changing it requires an index migration.
export const nonemptyAnswer = (column: string) =>
  `length(trim(${column},char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))>0`;
