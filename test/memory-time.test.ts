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
  ["last\tweek", "2026-11-09", "2026-11-16"],
])("parses %s in UTC", (text, from, to) => {
  const query = `recall ${text} from the ledger`;
  const window = parseMemoryTime(query, now);
  expect(window).toEqual({
    from: timestamp(from),
    to: timestamp(to),
    matched: { index: 7, text },
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
