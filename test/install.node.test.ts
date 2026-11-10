import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const version of ["22.18.0", "22.19.0", "24.0.0"]) {
  test(`source installer checks package Node floor before installing (${version})`, () => {
    const base = mkdtempSync(join(tmpdir(), "loop-install-contract-"));
    const source = join(base, "source"),
      root = join(base, "linked-source");
    mkdirSync(source);
    symlinkSync(source, root, "dir");
    try {
      const bin = join(root, "tools"),
        output = join(root, "installed");
      mkdirSync(bin);
      writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
      mkdirSync(join(root, "scripts"));
      cpSync("install", join(root, "install"));
      cpSync("scripts/check-node.cjs", join(root, "scripts/check-node.cjs"));
      cpSync("package.json", join(root, "package.json"));
      const npmLog = join(root, "npm.log");
      writeFileSync(
        join(bin, "node"),
        `#!${process.execPath}
const {spawnSync} = require('node:child_process');
if (process.argv[2] === 'scripts/check-node.cjs') {
  Object.defineProperty(process.versions, 'node', {value: ${JSON.stringify(version)}});
  require(require('node:path').resolve(process.argv[2]));
} else {
  const result = spawnSync(${JSON.stringify(process.execPath)}, process.argv.slice(2), {stdio:'inherit'});
  process.exitCode = result.status ?? 1;
}
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, "npm"),
        `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(npmLog)}, process.argv.slice(2).join(' ')+'\\n');
if (process.argv[2] === 'run' && process.argv[3] === 'build') {
  fs.mkdirSync('dist', {recursive:true});
  fs.writeFileSync('dist/cli.js', 'fixture');
}
`,
        { mode: 0o755 },
      );
      const result = spawnSync("bash", [join(root, "install")], {
        cwd: tmpdir(),
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: root,
          LOOP_INSTALL_BIN: output,
        },
      });
      if (version === "22.18.0") {
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /Loop needs Node.js >=22.19/);
        assert.equal(existsSync(npmLog), false);
        assert.equal(existsSync(output), false);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(npmLog, "utf8"), "ci\nrun build\n");
        assert.equal(
          realpathSync(join(output, "loop")),
          realpathSync(join(root, "dist/cli.js")),
        );
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}

test("installer takes its minimum from package metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-node-floor-"));
  try {
    mkdirSync(join(root, "scripts"));
    cpSync("scripts/check-node.cjs", join(root, "scripts/check-node.cjs"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ engines: { node: ">=24.1" } }),
    );
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `Object.defineProperty(process.versions, 'node', {value:'24.0.0'}); require(process.argv[1]);`,
        join(root, "scripts/check-node.cjs"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, />=24.1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
