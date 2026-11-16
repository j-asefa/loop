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

// Lines outside fenced code blocks, with inline code spans blanked.
function prose(text: string): string[] {
  let fenced = false;
  return text.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return "";
    }
    return fenced ? "" : line.replace(/`[^`]*`/g, "");
  });
}

// GitHub's heading anchors: rendered text, lowercased, punctuation other than
// hyphens and underscores removed, spaces to hyphens, -1/-2 for duplicates.
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const slug = heading[1]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    result.add(count ? `${slug}-${count}` : slug);
  }
  return result;
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
      const targets = [
        ...[...line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map(
          (match) => match[1],
        ),
        ...(/^@(\S+)\s*$/.exec(line.trim())?.slice(1) ?? []),
      ];
      for (const target of targets) {
        if (/^(https?:|mailto:)/.test(target)) continue;
        const [rawPath, anchor] = target.split("#", 2);
        const path = decodeURIComponent(rawPath);
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
        if (!anchorsOf(resolved).has(decodeURIComponent(anchor)))
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
