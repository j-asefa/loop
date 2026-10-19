import { afterAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  compareBuild,
  LOOP_REPOSITORY,
  type BuildStamp,
} from "../src/shared/build";

const dir = mkdtempSync(join(tmpdir(), "loop-build-identity-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("builds from an immutable clean source snapshot, and leaves dirty or gitless sources unverified", () => {
  const root = join(dir, "repo");
  mkdirSync(root);
  mkdirSync(join(root, "node_modules"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init");
  git("remote", "add", "origin", "https://github.com/j-asefa/loop.git");
  writeFileSync(join(root, "code.txt"), "committed source");
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  git("add", ".");
  git("commit", "-m", "source");
  const commit = git("rev-parse", "HEAD");
  const script = pathToFileURL(resolve("scripts/build-source.mjs")).href;
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import {buildSource} from ${JSON.stringify(script)};
    import {writeFileSync,readFileSync} from 'node:fs';
    import {join} from 'node:path';
    const root=process.argv[1];
    const source=await buildSource(root);
    writeFileSync(join(root,'code.txt'),'edited during build');
    const snapshot=readFileSync(join(source.directory,'code.txt'),'utf8');
    const dirty=await buildSource(root);
    console.log(JSON.stringify({stamp:source.stamp,snapshot,dirty:dirty.stamp}));
    await source.cleanup(); await dirty.cleanup();
  `,
        root,
      ],
      { encoding: "utf8" },
    ),
  );
  expect(result).toMatchObject({
    stamp: {
      repository: LOOP_REPOSITORY,
      commit,
      clean: true,
      ancestors: [commit],
    },
    snapshot: "committed source",
    dirty: { clean: false, commit: null },
  });
});

it("keeps the loaded identity after files are replaced and revokes clean provenance", async () => {
  const folder = join(dir, "runtime");
  mkdirSync(join(folder, "server"), { recursive: true });
  const old: BuildStamp = {
    id: "old-build",
    repository: LOOP_REPOSITORY,
    commit: "a".repeat(40),
    clean: true,
    builtAt: 1,
    ancestors: ["a".repeat(40)],
  };
  await build({
    entryPoints: ["src/server/build-runtime.ts"],
    outfile: join(folder, "server", "runtime.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    define: { __LOOP_BUILD__: JSON.stringify(old) },
  });
  writeFileSync(join(folder, "build-id.json"), JSON.stringify({ id: old.id }));
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import {observedBuild} from ${JSON.stringify(pathToFileURL(join(folder, "server", "runtime.mjs")).href)};
    import {writeFileSync} from 'node:fs';
    const before=observedBuild();
    writeFileSync(process.argv[1],JSON.stringify({id:'new-installation'}));
    const after=observedBuild();
    writeFileSync(process.argv[1],JSON.stringify({id:'old-build'}));
    console.log(JSON.stringify({before,after,restored:observedBuild()}));
  `,
        join(folder, "build-id.json"),
      ],
      { encoding: "utf8" },
    ),
  );
  expect(result.before).toMatchObject({ id: "old-build", clean: true });
  expect(result.after).toMatchObject({
    id: "old-build",
    commit: old.commit,
    clean: false,
  });
  expect(result.restored).toMatchObject({ id: "old-build", clean: false });
});

it("reports positive ancestry only, including descendants and missing history", () => {
  const commit = "b".repeat(40),
    before = "a".repeat(40),
    after = "c".repeat(40);
  const build: BuildStamp = {
    id: "build",
    repository: LOOP_REPOSITORY,
    commit: after,
    clean: true,
    builtAt: 1,
    ancestors: [after, commit, before],
  };
  const target = {
    repository: LOOP_REPOSITORY,
    commit,
    ancestors: [commit, before],
  };
  expect(compareBuild(build, target)).toBe("included");
  expect(
    compareBuild({ ...build, commit: before, ancestors: [before] }, target),
  ).toBe("predates");
  expect(compareBuild({ ...build, ancestors: [] }, target)).toBe("unknown");
  expect(compareBuild({ ...build, clean: false }, target)).toBe("unknown");
  expect(compareBuild(build, { ...target, repository: "another repo" })).toBe(
    "unknown",
  );
});
