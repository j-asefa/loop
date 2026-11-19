import { expect, it } from "vitest";
import {
  parseMemoryTime,
  withoutMemoryTime,
} from "../src/shared/memory-time.js";

const now = Date.parse("2026-11-19T15:30:00Z");
const timestamp = (day: string | null) =>
  day === null ? null : Date.parse(day);

it.each([
  ["today", "2026-11-19", "2026-11-20"],
  ["TODAY", "2026-11-19", "2026-11-20"],
  ["yesterday", "2026-11-18", "2026-11-19"],
  ["this week", "2026-11-16", "2026-11-23"],
  ["last week", "2026-11-09", "2026-11-16"],
  ["this month", "2026-11-01", "2026-12-01"],
  ["last month", "2026-10-01", "2026-11-01"],
  ["1 day ago", "2026-11-18", "2026-11-19"],
  ["11 days ago", "2026-11-08", "2026-11-09"],
  ["1 week ago", "2026-11-09", "2026-11-16"],
  ["2 weeks ago", "2026-11-02", "2026-11-09"],
  ["in October", "2026-10-01", "2026-11-01"],
  ["in December", "2025-12-01", "2026-01-01"],
  ["in January 2025", "2025-01-01", "2025-02-01"],
  ["in February 2024", "2024-02-01", "2024-03-01"],
  ["on 2024-02-29", "2024-02-29", "2024-03-01"],
  ["on 2026-10-12", "2026-10-12", "2026-10-13"],
  ["since 2026-10-12", "2026-10-12", null],
  ["since October", "2026-10-01", null],
  ["before 2026-10-12", null, "2026-10-12"],
  ["before October 2025", null, "2025-10-01"],
  ["before yesterday", null, "2026-11-18"],
  ["since 2 weeks ago", "2026-11-02", null],
  ["before\n2026-10-13", null, "2026-10-13"],
  ["last\tweek", "2026-11-09", "2026-11-16"],
])("parses %s in UTC", (text, from, to) => {
  const query = `recall ${text} from the ledger`;
  const window = parseMemoryTime(query, now);
  expect(window).toEqual({
    from: timestamp(from),
    to: timestamp(to),
    matched: [{ index: 7, text }],
  });
  expect(withoutMemoryTime(query, window)).toBe("recall   from the ledger");
});

it.each([
  'summarize "Last Week Tonight"',
  "summarize 'Last Week Tonight'",
  "it's called 'Last Week Tonight'",
  "summarize “Last Week Tonight”",
  "update the `today` field",
  "group by week",
  "read report.today field",
  "read today.report field",
  "read /reports/today/summary",
  "find the $today variable",
  "decisions since May joined the project",
  "review before June leaves the project",
  "review this example:\n```ts\nconst today = clock();\n```",
  "review this example:\n~~~text\nbefore 2026-10-12\n~~~",
  "review this example:\n```ts\nconst today = clock();",
  "search alerts+today@example.com",
  String.raw`find "status \"yesterday\" field"`,
  "before `cleanup` October",
  "on 2026-02-29",
  "before 2026-11-31",
  "last weekly",
  "not_today",
  "over 999999 weeks ago",
])("keeps %s searchable", (text) => {
  expect(parseMemoryTime(text, now)).toBeUndefined();
  expect(withoutMemoryTime(text)).toBe(text);
});

it("keeps the quoted occurrence of a phrase", () => {
  const query = 'find "last week" entries from last week';
  expect(withoutMemoryTime(query, parseMemoryTime(query, now))).toBe(
    'find "last week" entries from  ',
  );
});

it("applies and removes both ends of an explicit range", () => {
  const query = "since 2026-10-01 and before 2026-11-01 harvest";
  const window = parseMemoryTime(query, now);
  expect(window).toMatchObject({
    from: Date.parse("2026-10-01"),
    to: Date.parse("2026-11-01"),
  });
  expect(withoutMemoryTime(query, window)).toBe("  and   harvest");
});

it("uses the tighter repeated cutoff", () => {
  const query = "before 2026-10-20 and before 2026-10-13 harvest";
  const window = parseMemoryTime(query, now);
  expect(window?.to).toBe(Date.parse("2026-10-13"));
  expect(withoutMemoryTime(query, window)).toBe("  and   harvest");
});

it("applies an explicit cutoff after a standalone period", () => {
  const query = "harvest last week, before 2026-11-11";
  const window = parseMemoryTime(query, now);
  expect(window).toMatchObject({
    from: Date.parse("2026-11-09"),
    to: Date.parse("2026-11-11"),
  });
  expect(withoutMemoryTime(query, window)).toBe("harvest  ,  ");
});

it("ignores date examples in fenced code but preserves real constraints", () => {
  const query =
    "audit since 2026-10-01\n```text\nbefore 2026-10-02\n```\nbefore 2026-11-01";
  const window = parseMemoryTime(query, now);
  expect(window).toMatchObject({
    from: Date.parse("2026-10-01"),
    to: Date.parse("2026-11-01"),
  });
  expect(withoutMemoryTime(query, window)).toContain("before 2026-10-02");
});
