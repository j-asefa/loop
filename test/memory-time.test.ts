import { expect, it } from "vitest";
import {
  hasMemoryTimeExpression,
  parseMemoryTime,
  withoutMemoryTime,
} from "../src/shared/memory-time.js";

const now = Date.parse("2026-11-19T15:30:00Z");
const timestamp = (day: string | null) =>
  day === null ? null : Date.parse(day);

it.each([
  ["today", "2026-11-19", "2026-11-20"],
  ["TODAY", "2026-11-19", "2026-11-20"],
  ["tomorrow", "2026-11-20", "2026-11-21"],
  ["yesterday", "2026-11-18", "2026-11-19"],
  ["this week", "2026-11-16", "2026-11-23"],
  ["within the last week", "2026-11-09", "2026-11-16"],
  ["during last week", "2026-11-09", "2026-11-16"],
  ["last week", "2026-11-09", "2026-11-16"],
  ["this month", "2026-11-01", "2026-12-01"],
  ["last month", "2026-10-01", "2026-11-01"],
  ["1 day ago", "2026-11-18", "2026-11-19"],
  ["11 days ago", "2026-11-08", "2026-11-09"],
  ["1 week ago", "2026-11-09", "2026-11-16"],
  ["2 weeks ago", "2026-11-02", "2026-11-09"],
  ["from October 2026", "2026-10-01", "2026-11-01"],
  ["October 2026", "2026-10-01", "2026-11-01"],
  ["in October", "2026-10-01", "2026-11-01"],
  ["in December", "2025-12-01", "2026-01-01"],
  ["in January 2025", "2025-01-01", "2025-02-01"],
  ["in February 2024", "2024-02-01", "2024-03-01"],
  ["on 2024-02-29", "2024-02-29", "2024-03-01"],
  ["2026-10-12", "2026-10-12", "2026-10-13"],
  ["from 2026-10-12", "2026-10-12", "2026-10-13"],
  ["on 2026-10-12", "2026-10-12", "2026-10-13"],
  ["since 2026-10-12", "2026-10-12", null],
  ["since October", "2026-10-01", null],
  ["no earlier than 2026-10-12", "2026-10-12", null],
  ["no later than 2026-10-12", null, "2026-10-13"],
  ["on or before 2026-10-12", null, "2026-10-13"],
  ["on or after 2026-10-12", "2026-10-12", null],
  ["after 2026-10-12", "2026-10-13", null],
  ["before the 2026-10-12", null, "2026-10-12"],
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
  "find the implementation of `today",
  "group by week",
  "read report.today field",
  "read today.report field",
  "find the assignment to today[0]",
  "read /reports/today/summary",
  "find the $today variable",
  "find the ``today`` variable",
  "find the ```code `today`` variable```",
  "decisions since May's launch",
  "decisions before June’s launch",
  "find 'team's Last Week report'",
  "find ‘team’s Last Week report’",
  "review before yesterday's deploy",
  "review last week’s deploy",
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
    'find "last week" entries  ',
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

it("allows a specific date to narrow an earlier period", () => {
  const query = "harvest last month, specifically on 2026-10-12";
  expect(parseMemoryTime(query, now)).toMatchObject({
    from: Date.parse("2026-10-12"),
    to: Date.parse("2026-10-13"),
  });
});

it("removes the connective introducing a relative period", () => {
  const query = "tamarind from last week";
  expect(withoutMemoryTime(query, parseMemoryTime(query, now)).trim()).toBe(
    "tamarind",
  );
});

it("keeps a backtick in a quoted label from masking a later date", () => {
  const query = 'find "migration `" entries from last week for the `owner`';
  expect(parseMemoryTime(query, now)).toMatchObject({
    from: Date.parse("2026-11-09"),
    to: Date.parse("2026-11-16"),
  });
});

it("ignores quotes inside inline code when locating its closer", () => {
  const query = 'find `today "status` and "label" from last week';
  expect(parseMemoryTime(query, now)).toMatchObject({
    from: Date.parse("2026-11-09"),
    to: Date.parse("2026-11-16"),
  });
});

it("keeps unquoted function calls searchable", () => {
  expect(
    parseMemoryTime("find the implementation of today()", now),
  ).toBeUndefined();
});

it("ignores a date inside a multiline quotation", () => {
  const query = 'find "notes from last month\nabout harvest" from last week';
  expect(parseMemoryTime(query, now)).toMatchObject({
    from: Date.parse("2026-11-09"),
    to: Date.parse("2026-11-16"),
  });
});

it.each([
  "recall harvest notes, but not on 2026-10-12",
  "harvest yesterday or today",
  "harvest on 2026-10-12 or 2026-10-13",
  "harvest in October or November",
  "harvest except for yesterday",
  "harvest last week, excluding 2026-11-12",
  "harvest not (yesterday)",
  "harvest notes without yesterday",
  "harvest last month, or even on 2026-10-12",
  "harvest notes from this week or just today",
  "harvest notes from this week or, if there are any recent entries, today",
  "harvest this week or, if needed, today",
  "harvest this week, excluding: yesterday",
  "harvest this week, excluding: on 2026-11-18",
  'excluding "harvest" notes on 2026-10-12',
  "harvest this week, excluding the notes on 2026-11-18",
  "harvest October or in November",
  "harvest yesterday or tomorrow",
  "harvest notes, exclude yesterday",
  "harvest notes from this week other than yesterday",
  "omit notes from yesterday",
  "find harvest notes from this week, except for November",
  "harvest notes in October 12, 2026",
  "harvest notes from today or earlier",
  "harvest notes from this week, but do not retrieve notes from yesterday",
  "notes from this week if available, or yesterday",
  "find harvest notes from this week, but ignore yesterday",
  "find harvest notes from any day apart from yesterday",
  "Find amethyst harvest notes. Do not include notes from yesterday",
  "harvest notes from this week and/or today",
  "harvest notes (today) or this week",
  "Do not use amethyst harvest notes from yesterday",
  "find harvest notes in October and November",
  "find harvest notes in October, November, or December",
  "find harvest notes this week, excluding any and all notes that were written yesterday",
  "find harvest notes from this week or, for ‘amethyst’, yesterday",
  "Harvest notes, don’t include notes from yesterday",
  "harvest notes from last week, but never on 2026-11-12",
  "harvest notes, but not notes from yesterday",
  "harvest notes without any entries from yesterday",
  "harvest since 2026-10-01 (or before 2026-11-01)",
  "harvest notes from this week, but not including yesterday",
  "harvest notes from this week, but leave out yesterday",
  "harvest notes, excluding specifically yesterday",
  "amethyst this week or (preferably) today",
  "harvest notes from this week, but skip yesterday",
  "harvest, excluding notes before 2026-10-12",
  "harvest 2026-10-12 or on 2026-10-13",
  "harvest this week, excluding notes dated yesterday",
  "harvest this week, excluding anything from today",
  "harvest this week, excluding records from today",
  "harvest not during October 2026",
  "harvest this week, excluding all of yesterday",
  "harvest on 2026-10-12 or (2026-10-13)",
  "compare harvest last week with last month",
  "harvest since Monday, excluding yesterday",
])("keeps unsupported date choices searchable in %s", (query) => {
  const window = parseMemoryTime(query, now);
  expect(window).toBeUndefined();
  expect(hasMemoryTimeExpression(query, now)).toBe(true);
  expect(withoutMemoryTime(query, window)).toBe(query);
});

it("keeps line-leading inline code from masking a later date", () => {
  const query = "```today``` harvest notes from last week";
  expect(parseMemoryTime(query, now)).toMatchObject({
    from: Date.parse("2026-11-09"),
    to: Date.parse("2026-11-16"),
  });
});

it("keeps contradictory bounds empty so recall abstains", () => {
  expect(parseMemoryTime("last week, since 2026-11-20", now)).toMatchObject({
    from: Date.parse("2026-11-20"),
    to: Date.parse("2026-11-16"),
  });
});

it("uses the narrower period when it appears first", () => {
  expect(
    parseMemoryTime("notes from yesterday, within this week", now),
  ).toMatchObject({
    from: Date.parse("2026-11-18"),
    to: Date.parse("2026-11-19"),
  });
});

it("keeps a date when without modifies the subject", () => {
  expect(
    parseMemoryTime("harvest notes without irrigation from last week", now),
  ).toMatchObject({
    from: Date.parse("2026-11-09"),
    to: Date.parse("2026-11-16"),
  });
});

it("does not treat bare month-shaped names as a date alternative", () => {
  expect(
    parseMemoryTime("Ask May or June for harvest notes from last week", now),
  ).toMatchObject({
    from: Date.parse("2026-11-09"),
    to: Date.parse("2026-11-16"),
  });
});

it("keeps a later date after excluding someone with a month-shaped name", () => {
  const query = "Ask everyone except May for harvest notes from last week";
  expect(parseMemoryTime(query, now)).toMatchObject({
    from: Date.parse("2026-11-09"),
    to: Date.parse("2026-11-16"),
  });
});

it("keeps an explicit cutoff before a parenthesized date", () => {
  expect(parseMemoryTime("harvest before (2026-10-12)", now)).toMatchObject({
    from: null,
    to: Date.parse("2026-10-12"),
  });
});

it("ignores subject alternatives between explicit bounds", () => {
  const query =
    "Since 2026-10-01, find amethyst or garnet notes before 2026-11-01";
  expect(parseMemoryTime(query, now)).toMatchObject({
    from: Date.parse("2026-10-01"),
    to: Date.parse("2026-11-01"),
  });
});

it("keeps a date window after an author alternative", () => {
  expect(
    parseMemoryTime("Find harvest notes by May or Alex from last week", now),
  ).toMatchObject({
    from: Date.parse("2026-11-09"),
    to: Date.parse("2026-11-16"),
  });
});

it("preserves a narrower date after a choice of subjects", () => {
  const query = "Last month, find amethyst or garnet notes on 2026-10-12";
  expect(parseMemoryTime(query, now)).toMatchObject({
    from: Date.parse("2026-10-12"),
    to: Date.parse("2026-10-13"),
  });
});

it("keeps the date when negation modifies an action", () => {
  const query = "Find notes about why amethyst did not ship last week";
  expect(parseMemoryTime(query, now)).toMatchObject({
    from: Date.parse("2026-11-09"),
    to: Date.parse("2026-11-16"),
  });
});

it("preserves the date when an exclusion verb describes the topic", () => {
  expect(
    parseMemoryTime(
      "find notes on how to exclude duplicate rows from last week",
      now,
    ),
  ).toMatchObject({
    from: Date.parse("2026-11-09"),
    to: Date.parse("2026-11-16"),
  });
});
