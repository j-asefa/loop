// Guidance files (AGENTS.md, CLAUDE.md, docs/*.md and nested AGENTS.md
// files) must only point at paths and heading anchors that exist: agents
// follow a stale pointer instead of the code. Links are found with a regex
// over Markdown outside fenced code blocks and inline code spans; external
// URLs are not fetched.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function nestedAgents(root: string, dir: string): string[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return nestedAgents(root, path);
    return entry.name === "AGENTS.md" ? [path] : [];
  });
}

function guidanceFiles(root: string): string[] {
  const top = ["AGENTS.md", "CLAUDE.md"].filter((file) =>
    existsSync(join(root, file)),
  );
  const docs = existsSync(join(root, "docs"))
    ? readdirSync(join(root, "docs"))
        .filter((file) => file.endsWith(".md"))
        .map((file) => join("docs", file))
    : [];
  const nested = ["src", "test", "migrations"].flatMap((dir) =>
    nestedAgents(root, dir),
  );
  return [...top, ...docs.sort(), ...nested.sort()];
}

// CommonMark fences: a closing fence uses the opening character, is at least
// as long, and has no info string. Returns, per line, whether it is code.
function codeLines(lines: string[]): boolean[] {
  let open: { char: string; length: number } | null = null;
  return lines.map((line) => {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open) {
      if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
        open = { char: fence[1][0], length: fence[1].length };
        return true;
      }
      return false;
    }
    if (
      fence &&
      fence[1][0] === open.char &&
      fence[1].length >= open.length &&
      !fence[2].trim()
    )
      open = null;
    return true;
  });
}

// Lines outside fenced code blocks, with inline code spans blanked.
function prose(text: string): string[] {
  const lines = text.split("\n");
  const code = codeLines(lines);
  return lines.map((line, index) =>
    code[index] ? "" : line.replace(/(`+)[^`]*?\1/g, ""),
  );
}

// GitHub's heading anchors: rendered text, lowercased, punctuation other than
// hyphens and underscores removed, spaces to hyphens, -1/-2 for duplicates.
// Code spans keep their literal text; links and HTML tags outside them render
// as their text.
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  const lines = markdown.split("\n");
  const code = codeLines(lines);
  lines.forEach((line, index) => {
    const heading = code[index]
      ? null
      : /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (!heading) return;
    const text = heading[1]
      .split(/(`+[^`]*?`+)/)
      .map((part) =>
        part.startsWith("`")
          ? part.replace(/^`+|`+$/g, "")
          : part
              .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
              .replace(/<[^>]+>/g, ""),
      )
      .join("");
    const slug = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    result.add(count ? `${slug}-${count}` : slug);
  });
  return result;
}

// Inline destinations (`[t](path)`, `[t](<path with spaces>)`), reference
// definitions (`[label]: path`) and standalone `@path` import lines.
function linkTargets(line: string): string[] {
  return [
    ...[...line.matchAll(/\]\(\s*(?:<([^>\n]*)>|([^)\s<>]+))/g)].map(
      (match) => match[1] ?? match[2],
    ),
    ...(/^ {0,3}\[[^\]]+\]:\s*(?:<([^>]*)>|(\S+))/
      .exec(line)
      ?.slice(1)
      .filter((target): target is string => target !== undefined) ?? []),
    ...(/^@(\S+)\s*$/.exec(line.trim())?.slice(1) ?? []),
  ];
}

// Literal `%` is a valid filename character; decode only well-formed escapes.
function decoded(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function brokenGuidanceLinks(root: string, files: string[]): string[] {
  const anchorCache = new Map<string, Set<string>>();
  const anchorsOf = (path: string) => {
    if (!anchorCache.has(path))
      anchorCache.set(path, anchors(readFileSync(path, "utf8")));
    return anchorCache.get(path)!;
  };
  const broken: string[] = [];
  for (const file of files) {
    const source = join(root, file);
    const lines = prose(readFileSync(source, "utf8"));
    lines.forEach((line, index) => {
      for (const target of linkTargets(line)) {
        // Any URI scheme (https:, mailto:, tel:) is external and not fetched.
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const [rawPath, anchor] = target.split("#", 2);
        const path = decoded(rawPath);
        const resolved = path ? resolve(dirname(source), path) : source;
        const where = `${file}:${index + 1}`;
        const shown = relative(root, resolved).split(sep).join("/");
        if (!existsSync(resolved)) {
          broken.push(
            `${where} links to ${shown}, which does not exist. Fix the link or remove it; agents follow a pointer even when it leads nowhere.`,
          );
          continue;
        }
        if (anchor === undefined) continue;
        if (statSync(resolved).isDirectory() || !resolved.endsWith(".md")) {
          broken.push(
            `${where} links to #${anchor} in ${shown}; anchors are only checked in Markdown files. Link the file without the anchor.`,
          );
          continue;
        }
        if (!anchorsOf(resolved).has(decoded(anchor)))
          broken.push(
            `${where} links to ${shown}#${anchor}, but no heading there produces that anchor. Link an existing heading or remove the anchor.`,
          );
      }
    });
  }
  return broken;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "loop-guidance-links-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

it("reports missing paths and anchors with file, line and the fix", () => {
  const root = fixture({
    "AGENTS.md": [
      "[ok](docs/guide.md) [anchor](docs/guide.md#first-step)",
      "[dup](docs/guide.md#first-step-1) [web](https://example.com/x)",
      "[gone](docs/missing.md) [bad](docs/guide.md#nowhere)",
      "`[code](docs/ignored.md)`",
      "```",
      "[fenced](docs/ignored.md)",
      "```",
      "[code anchor](src/a.ts#L1)",
    ].join("\n"),
    "CLAUDE.md": "@AGENTS.md\n@missing.md\n",
    "docs/guide.md":
      "# Guide\n\n## First step\n\n## First step\n\n[self](#guide) [back](../AGENTS.md)\n",
    "src/a.ts": "export {};\n",
    "src/server/sql/AGENTS.md": "[up](../../../docs/guide.md#first-step)\n",
  });
  expect(guidanceFiles(root)).toEqual([
    "AGENTS.md",
    "CLAUDE.md",
    "docs/guide.md",
    "src/server/sql/AGENTS.md",
  ]);
  expect(brokenGuidanceLinks(root, guidanceFiles(root))).toEqual([
    "AGENTS.md:3 links to docs/missing.md, which does not exist. Fix the link or remove it; agents follow a pointer even when it leads nowhere.",
    "AGENTS.md:3 links to docs/guide.md#nowhere, but no heading there produces that anchor. Link an existing heading or remove the anchor.",
    "AGENTS.md:8 links to #L1 in src/a.ts; anchors are only checked in Markdown files. Link the file without the anchor.",
    "CLAUDE.md:2 links to missing.md, which does not exist. Fix the link or remove it; agents follow a pointer even when it leads nowhere.",
  ]);
});

it("checks reference definitions, angle destinations, nested fences and literal percent signs", () => {
  const root = fixture({
    "AGENTS.md": [
      "[guide][dev] [spaced](<docs/a guide.md>) [gone](<docs/no guide.md>)",
      "[dev]: docs/missing.md",
      "[ok]: <docs/a guide.md#loop-preview-create-name>",
      "````md",
      "```",
      "[example](docs/ignored.md)",
      "```",
      "````",
      "```",
      "~~~",
      "[example](docs/ignored-too.md)",
      "```",
      "[real](docs/after-fence.md) [percent](docs/100%-coverage.md)",
      "[call](tel:+15550100)",
    ].join("\n"),
    "docs/a guide.md": "## `loop preview create <name>`\n",
    "docs/100%-coverage.md": "# Coverage\n",
  });
  expect(brokenGuidanceLinks(root, ["AGENTS.md"])).toEqual([
    "AGENTS.md:1 links to docs/no guide.md, which does not exist. Fix the link or remove it; agents follow a pointer even when it leads nowhere.",
    "AGENTS.md:2 links to docs/missing.md, which does not exist. Fix the link or remove it; agents follow a pointer even when it leads nowhere.",
    "AGENTS.md:13 links to docs/after-fence.md, which does not exist. Fix the link or remove it; agents follow a pointer even when it leads nowhere.",
  ]);
});

it("derives GitHub heading anchors from rendered text", () => {
  expect([
    ...anchors(
      "# `runs.state`\n## Tests by boundary\n## Recipe: add a route\n## [Linked](x.md) title\n## Tests by boundary\n",
    ),
  ]).toEqual([
    "runsstate",
    "tests-by-boundary",
    "recipe-add-a-route",
    "linked-title",
    "tests-by-boundary-1",
  ]);
});

it("keeps every link and anchor in the repository's guidance files resolvable", () => {
  const files = guidanceFiles(repo);
  expect(files).toContain("AGENTS.md");
  expect(brokenGuidanceLinks(repo, files)).toEqual([]);
});
