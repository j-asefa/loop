// Guidance files (AGENTS.md, CLAUDE.md, docs/*.md, nested AGENTS.md or CLAUDE.md
// files and .claude/rules/*.md) must only point at paths and heading anchors that exist: agents
// follow a stale pointer instead of the code. Links come from the marked
// lexer (already a dependency), so code blocks, code spans, reference links
// and setext headings follow CommonMark; external URLs are not fetched.
import {
  existsSync,
  globSync,
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
import { Lexer, type Token } from "marked";
import { parse as parseYaml } from "yaml";
import { afterEach, expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function nestedAgents(root: string, dir: string): string[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return nestedAgents(root, path);
    return ["AGENTS.md", "CLAUDE.md"].includes(entry.name) ? [path] : [];
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
  const rules = existsSync(join(root, ".claude/rules"))
    ? (
        readdirSync(join(root, ".claude/rules"), {
          recursive: true,
        }) as string[]
      )
        .filter((file) => file.endsWith(".md"))
        .map((file) => join(".claude/rules", file))
    : [];
  return [...top, ...docs.sort(), ...nested.sort(), ...rules.sort()];
}

// YAML front matter (Claude rules' `paths:`), replaced by blank lines so the
// body keeps its line numbers.
function frontMatter(text: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  return {
    yaml: match?.[1] ?? "",
    body: match
      ? match[0].replace(/[^\n]/g, "") + text.slice(match[0].length)
      : text,
  };
}

// Claude rules here are path-scoped pointers: `paths:` must be a string or a
// list of strings, and each glob must match at least one file.
function deadRulePaths(root: string, file: string): string[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(
      frontMatter(readFileSync(join(root, file), "utf8")).yaml,
    );
  } catch (error) {
    return [
      `${file} has front matter that is not valid YAML: ${(error as Error).message.split("\n")[0]}`,
    ];
  }
  const value = (parsed as { paths?: unknown } | null)?.paths;
  const globs = typeof value === "string" ? [value] : value;
  if (
    !Array.isArray(globs) ||
    !globs.length ||
    !globs.every((glob) => typeof glob === "string")
  )
    return [
      `${file} has no paths: list of globs. Rules here are path-scoped pointers; put guidance for every file in AGENTS.md instead.`,
    ];
  return globs
    .filter(
      (glob) =>
        !globSync(glob, { cwd: root }).some((match) =>
          statSync(join(root, match)).isFile(),
        ),
    )
    .map(
      (glob) =>
        `${file} lists paths glob ${glob}, which matches no file. Fix the glob or remove the rule.`,
    );
}

type Node = Token & {
  tokens?: Token[];
  items?: Token[];
  header?: { text: string; tokens: Token[] }[];
  rows?: { text: string; tokens: Token[] }[][];
  href?: string;
  text?: string;
};

function children(token: Node): Node[] {
  const cells = [...(token.header ?? []), ...(token.rows ?? []).flat()].map(
    (cell) => ({ type: "cell", raw: cell.text, tokens: cell.tokens }) as Node,
  );
  return [...(token.tokens ?? []), ...(token.items ?? []), ...cells] as Node[];
}

// Each link or image destination and each standalone `@path` import line, with
// its character offset. Top-level token sources concatenate to the document;
// a child is located inside its parent's source.
function linkTargets(markdown: string) {
  const found: { target: string; offset: number }[] = [];
  const visit = (token: Node, base: number) => {
    if (["code", "codespan", "html"].includes(token.type)) return;
    if ((token.type === "link" || token.type === "image") && token.href)
      found.push({ target: token.href, offset: base });
    if (token.type === "paragraph") {
      let at = 0;
      for (const line of token.raw.split("\n")) {
        const target = /^@(\S+)\s*$/.exec(line.trim())?.[1];
        if (target) found.push({ target, offset: base + at });
        at += line.length + 1;
      }
    }
    let cursor = 0;
    for (const child of children(token)) {
      const at = child.raw ? token.raw.indexOf(child.raw, cursor) : -1;
      if (at >= 0) cursor = at + child.raw.length;
      visit(child, base + (at >= 0 ? at : cursor));
    }
  };
  let offset = 0;
  for (const token of Lexer.lex(markdown) as Node[]) {
    visit(token, offset);
    offset += token.raw.length;
  }
  return found;
}

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
// Character references render as their character outside code spans.
const unescape = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ref: string) =>
    ref[0] === "#"
      ? String.fromCodePoint(
          ref[1].toLowerCase() === "x"
            ? parseInt(ref.slice(2), 16)
            : Number(ref.slice(1)),
        )
      : (entities[ref.toLowerCase()] ?? match),
  );

// Rendered heading text: code spans keep their literal text, links render as
// their text, HTML tags are dropped and character references are decoded.
function plain(tokens: Node[]): string {
  return tokens
    .map((token) =>
      token.type === "html"
        ? ""
        : token.type !== "codespan" && token.tokens
          ? plain(token.tokens as Node[])
          : token.type === "codespan"
            ? (token.text ?? "")
            : unescape(token.text ?? ""),
    )
    .join("");
}

// GitHub's heading anchors: rendered text, lowercased, punctuation other than
// hyphens and underscores removed, spaces to hyphens, -1/-2 for duplicates.
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  const visit = (token: Node) => {
    if (token.type === "heading") {
      const slug = plain(token.tokens as Node[])
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s/g, "-");
      // github-slugger: bump the base slug's counter until the suffixed
      // anchor is unused, so "Foo", "Foo", "Foo-1" give foo, foo-1, foo-1-1.
      let anchor = slug;
      while (seen.has(anchor)) {
        const count = seen.get(slug)! + 1;
        seen.set(slug, count);
        anchor = `${slug}-${count}`;
      }
      seen.set(anchor, 0);
      result.add(anchor);
    }
    children(token).forEach(visit);
  };
  (Lexer.lex(markdown) as Node[]).forEach(visit);
  return result;
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
    const text = frontMatter(readFileSync(source, "utf8")).body;
    for (const { target, offset } of linkTargets(text)) {
      // Any URI scheme (https:, mailto:, tel:) or a protocol-relative //host
      // destination is external and not fetched.
      if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
      const [beforeAnchor, anchor] = target.split("#", 2);
      // A query string does not name a different local file.
      const rawPath = beforeAnchor.split("?")[0];
      const path = decoded(rawPath);
      // GitHub resolves a leading slash from the repository root.
      const resolved = !path
        ? source
        : path.startsWith("/")
          ? join(root, path)
          : resolve(dirname(source), path);
      const where = `${file}:${text.slice(0, offset).split("\n").length}`;
      const shown = relative(root, resolved).split(sep).join("/");
      if (relative(root, resolved).split(sep)[0] === "..") {
        broken.push(
          `${where} links to ${path}, which is outside the repository. Link a repository file or an external URL.`,
        );
        continue;
      }
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
    "src/server/sql/CLAUDE.md": "@AGENTS.md\n",
  });
  expect(guidanceFiles(root)).toEqual([
    "AGENTS.md",
    "CLAUDE.md",
    "docs/guide.md",
    "src/server/sql/AGENTS.md",
    "src/server/sql/CLAUDE.md",
  ]);
  expect(brokenGuidanceLinks(root, guidanceFiles(root))).toEqual([
    "AGENTS.md:3 links to docs/missing.md, which does not exist. Fix the link or remove it; agents follow a pointer even when it leads nowhere.",
    "AGENTS.md:3 links to docs/guide.md#nowhere, but no heading there produces that anchor. Link an existing heading or remove the anchor.",
    "AGENTS.md:8 links to #L1 in src/a.ts; anchors are only checked in Markdown files. Link the file without the anchor.",
    "CLAUDE.md:2 links to missing.md, which does not exist. Fix the link or remove it; agents follow a pointer even when it leads nowhere.",
  ]);
});

it("follows CommonMark for references, destinations, code and headings", () => {
  const root = fixture({
    "AGENTS.md": [
      "[guide][dev] [spaced](<docs/a guide.md>) [gone](<docs/no guide.md>)",
      "[parens](docs/setup_(advanced).md) [anchor][ok] [linked](docs/a%20guide.md#linked-title)",
      "",
      "[dev]: docs/missing.md",
      "[ok]: <docs/a guide.md#loop-preview-create-name>",
      "",
      "````md",
      "```",
      "[example](docs/ignored.md)",
      "```",
      "````",
      "",
      "```",
      "~~~",
      "[example](docs/ignored-too.md)",
      "```",
      "",
      "    [indented example](docs/ignored-three.md)",
      "",
      "[real](docs/after-fence.md) [percent](docs/100%-coverage.md)",
      "[call](tel:+15550100) [setext](docs/a%20guide.md#setext-title)",
      "[host](//example.com/docs) [query](docs/a%20guide.md?plain=1#tom--jerry)",
      "[third](docs/a%20guide.md#foo-1-1) [rooted](/docs/a%20guide.md) [outside](../../etc/hosts)",
    ].join("\n"),
    "docs/a guide.md": [
      "## `loop preview create <name>`",
      "",
      "## [Linked][ref] title",
      "",
      "## Tom &amp; Jerry",
      "",
      "## Foo",
      "",
      "## Foo",
      "",
      "## Foo-1",
      "",
      "Setext title",
      "============",
      "",
      "[ref]: ../AGENTS.md",
      "",
    ].join("\n"),
    "docs/setup_(advanced).md": "# Setup\n",
    "docs/100%-coverage.md": "# Coverage\n",
  });
  expect(brokenGuidanceLinks(root, ["AGENTS.md"])).toEqual([
    "AGENTS.md:1 links to docs/missing.md, which does not exist. Fix the link or remove it; agents follow a pointer even when it leads nowhere.",
    "AGENTS.md:1 links to docs/no guide.md, which does not exist. Fix the link or remove it; agents follow a pointer even when it leads nowhere.",
    "AGENTS.md:20 links to docs/after-fence.md, which does not exist. Fix the link or remove it; agents follow a pointer even when it leads nowhere.",
    "AGENTS.md:23 links to ../../etc/hosts, which is outside the repository. Link a repository file or an external URL.",
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

it("reports Claude rules whose paths match nothing, keeping body line numbers", () => {
  const root = fixture({
    "src/a.ts": "export {};\n",
    ".claude/rules/a.md":
      '---\npaths:\n  - "src/*.ts"\n  - "lib/**/*.ts"\n---\n\n[gone](../../missing.md)\n',
    ".claude/rules/b.md": "No front matter.\n",
    ".claude/rules/nested/c.md":
      '---\r\npaths: [\'src/*.ts\', "src"]\r\nother:\r\n  - "lib/**"\r\n---\r\nBody.\r\n',
    ".claude/rules/d.md": '---\npaths: "src/a.ts"\n---\n',
  });
  expect(guidanceFiles(root)).toEqual([
    ".claude/rules/a.md",
    ".claude/rules/b.md",
    ".claude/rules/d.md",
    ".claude/rules/nested/c.md",
  ]);
  // Flow lists, single quotes, CRLF and unrelated keys parse as YAML; a glob
  // that matches only a directory matches no file.
  expect(deadRulePaths(root, ".claude/rules/nested/c.md")).toEqual([
    ".claude/rules/nested/c.md lists paths glob src, which matches no file. Fix the glob or remove the rule.",
  ]);
  expect(deadRulePaths(root, ".claude/rules/d.md")).toEqual([]);
  expect(deadRulePaths(root, ".claude/rules/a.md")).toEqual([
    ".claude/rules/a.md lists paths glob lib/**/*.ts, which matches no file. Fix the glob or remove the rule.",
  ]);
  expect(deadRulePaths(root, ".claude/rules/b.md")).toEqual([
    ".claude/rules/b.md has no paths: list of globs. Rules here are path-scoped pointers; put guidance for every file in AGENTS.md instead.",
  ]);
  expect(brokenGuidanceLinks(root, [".claude/rules/a.md"])).toEqual([
    ".claude/rules/a.md:7 links to missing.md, which does not exist. Fix the link or remove it; agents follow a pointer even when it leads nowhere.",
  ]);
});

it("keeps every Claude rule's paths matching repository files", () => {
  expect(
    guidanceFiles(repo)
      .filter((file) => file.startsWith(".claude/rules/"))
      .flatMap((file) => deadRulePaths(repo, file)),
  ).toEqual([]);
});

it("keeps every link and anchor in the repository's guidance files resolvable", () => {
  const files = guidanceFiles(repo);
  expect(files).toContain("AGENTS.md");
  expect(brokenGuidanceLinks(repo, files)).toEqual([]);
});
