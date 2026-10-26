import { afterAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  cpSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { LOOP_REPOSITORY, type BuildStamp } from "../src/shared/build";

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

it("uses the captured Dockerfile for image builds and rejects external files", () => {
  const root = join(dir, "image"),
    bin = join(dir, "bin");
  mkdirSync(root);
  mkdirSync(bin);
  mkdirSync(join(root, "node_modules"));
  const dockerfile = join(root, "Dockerfile.companion");
  writeFileSync(dockerfile, "FROM committed-source\n");
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
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
      { stdio: "pipe" },
    );
  git("init");
  git("remote", "add", "origin", "https://github.com/j-asefa/loop.git");
  git("add", ".");
  git("commit", "-m", "image source");
  const fake = join(bin, "docker");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
fs.writeFileSync(process.env.FIXTURE_DOCKERFILE,'changed after snapshot');
const option=args.findIndex(x=>x==='-f'||x==='--file');
const file=option>=0?args[option+1]:args.find(x=>x.startsWith('--file=')).slice(7);
console.log(JSON.stringify({file:fs.readFileSync(file,'utf8'),stamp:JSON.parse(fs.readFileSync(path.join(args.at(-1),'.loop-build-source.json'),'utf8'))}));
`,
  );
  chmodSync(fake, 0o755);
  const env = {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    FIXTURE_DOCKERFILE: dockerfile,
  };
  const wrapper = resolve("scripts/build-image.mjs");
  for (const args of [
    ["-f", "Dockerfile.companion"],
    ["--file=Dockerfile.companion"],
    ["-fDockerfile.companion"],
    ["-f=Dockerfile.companion"],
    ["--file", dockerfile],
  ]) {
    writeFileSync(dockerfile, "FROM committed-source\n");
    const result = JSON.parse(
      execFileSync(process.execPath, [wrapper, ...args], {
        cwd: root,
        env,
        encoding: "utf8",
      }),
    );
    expect(result).toMatchObject({
      file: "FROM committed-source\n",
      stamp: { clean: true, repository: LOOP_REPOSITORY },
    });
    expect(readFileSync(dockerfile, "utf8")).toBe("changed after snapshot");
  }
  writeFileSync(dockerfile, "FROM committed-source\n");
  const outside = join(dir, "outside.Dockerfile");
  writeFileSync(outside, "FROM external-source\n");
  expect(() =>
    execFileSync(process.execPath, [wrapper, "--file", outside], {
      cwd: root,
      env,
      stdio: "pipe",
    }),
  ).toThrow(/inside the captured repository/);
});

it.each(["mjs", "ts"])(
  "runs staged %s helpers, migrations and metadata from captured source after checkout edits",
  async (extension) => {
    const root = join(dir, `staged-assets-${extension}`);
    for (const folder of [
      "src/server",
      "runtime",
      "native",
      "migrations",
      "deployment",
      "node_modules",
    ])
      mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "node_modules\ndist\n");
    writeFileSync(
      join(root, "package.json"),
      '{"type":"module","version":"captured-version"}',
    );
    writeFileSync(
      join(root, `runtime/helper.${extension}`),
      `export {value} from './sibling.${extension}';`,
    );
    writeFileSync(
      join(root, `runtime/sibling.${extension}`),
      `export const value${extension === "ts" ? ": string" : ""}="captured-runtime";`,
    );
    writeFileSync(
      join(root, "native/helper.js"),
      'export const value="captured-native";',
    );
    writeFileSync(join(root, "migrations/001.sql"), "captured-migration");
    writeFileSync(join(root, "deployment/versions.json"), "{}");
    writeFileSync(
      join(root, "src/server/probe.ts"),
      `
import {readFileSync} from 'node:fs';
import {value} from '../../runtime/helper.${extension}';
export {value as native} from '../../native/helper.js';
export {value};
const migration='001.sql';
export const sql=readFileSync(new URL('../../migrations/'+migration,import.meta.url),'utf8');
export const version=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version;
export const dynamic=(await import('../../runtime/helper.${extension}')).value;
`,
    );
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
        { stdio: "pipe" },
      );
    git("init");
    git("remote", "add", "origin", "https://github.com/j-asefa/loop.git");
    git("add", ".");
    git("commit", "-m", "runtime source");
    const { buildSource } = await import(
      pathToFileURL(resolve("scripts/build-source.mjs")).href
    );
    const { stageRuntimeAssets } = await import(
      pathToFileURL(resolve("scripts/build-runtime-assets.mjs")).href
    );
    const source = await buildSource(root);
    try {
      expect(source.stamp.clean).toBe(true);
      writeFileSync(
        join(root, `runtime/helper.${extension}`),
        'throw new Error("mutable runtime loaded");',
      );
      writeFileSync(
        join(root, "native/helper.js"),
        'throw new Error("mutable native helper loaded");',
      );
      writeFileSync(join(root, "migrations/001.sql"), "later-migration");
      writeFileSync(
        join(root, "package.json"),
        '{"type":"module","version":"later-version"}',
      );
      await build({
        entryPoints: [join(source.directory, "src/server/probe.ts")],
        outbase: join(source.directory, "src"),
        outdir: join(source.directory, "dist"),
        platform: "node",
        format: "esm",
      });
      await stageRuntimeAssets(
        source.directory,
        join(source.directory, "dist"),
      );
      cpSync(join(source.directory, "dist"), join(root, "dist"), {
        recursive: true,
      });
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `console.log(JSON.stringify(await import(${JSON.stringify(pathToFileURL(join(root, "dist/server/probe.js")).href)})))`,
          ],
          { encoding: "utf8" },
        ),
      );
      expect(result).toEqual({
        value: "captured-runtime",
        native: "captured-native",
        sql: "captured-migration",
        version: "captured-version",
        dynamic: "captured-runtime",
      });
      expect(readFileSync(join(root, "migrations/001.sql"), "utf8")).toBe(
        "later-migration",
      );
    } finally {
      await source.cleanup();
    }
  },
);

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
