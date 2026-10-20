import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

const script = fileURLToPath(
  new URL("../deployment/archive-backups.py", import.meta.url),
);
const roots: string[] = [];
const backupName = "workspace-backup";
const archiveName = "workspace-backup.tar.gz";

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(count = 4) {
  const root = mkdtempSync(join(tmpdir(), "loop-backup-archive-"));
  roots.push(root);
  const releases = Array.from({ length: count }, (_, index) => {
    const release = join(
      root,
      `main-202610${String(index + 1).padStart(2, "0")}T000000Z-abcdef1`,
    );
    const backup = join(release, backupName);
    mkdirSync(join(backup, "empty"), { recursive: true, mode: 0o700 });
    writeFileSync(join(backup, "loop.db"), Buffer.from([0, 255, index, 10]));
    writeFileSync(join(backup, "credentials"), "fixture credentials\n", {
      mode: 0o600,
    });
    return release;
  });
  return { root, releases };
}

function run(root: string, ...args: string[]) {
  return spawnSync("python3", [script, "--releases", root, ...args], {
    encoding: "utf8",
  });
}

function success(result: ReturnType<typeof run>) {
  assert.equal(
    result.status,
    0,
    result.error?.message || result.stderr || result.stdout,
  );
}

function restore(release: string, destination: string) {
  mkdirSync(destination, { recursive: true });
  const result = spawnSync(
    "tar",
    ["-xzf", join(release, archiveName), "-C", destination],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
}

test("archives old backups with usable contents and permissions, retaining recent and linked backups", () => {
  const { root, releases } = fixture(6);
  const old = join(releases[1], backupName);
  symlinkSync("credentials", join(old, "credential-link"));
  linkSync(join(old, "loop.db"), join(old, "database-hardlink"));
  const alias = join(root, "main-20261030T000000Z-abcdef1");
  mkdirSync(alias);
  symlinkSync(join(releases[0], backupName), join(alias, backupName));
  const unrelated = join(root, "unrelated", backupName);
  mkdirSync(unrelated, { recursive: true });
  writeFileSync(join(unrelated, "preserve"), "unrelated");

  success(run(root));
  assert(
    existsSync(join(releases[0], backupName)),
    "symlink target remains unpacked",
  );
  for (const release of releases.slice(3))
    assert(existsSync(join(release, backupName)));
  for (const release of releases.slice(1, 3)) {
    assert(!existsSync(join(release, backupName)));
    assert.equal(lstatSync(join(release, archiveName)).mode & 0o777, 0o600);
  }
  assert(existsSync(join(unrelated, "preserve")));
  const restored = join(root, "restored");
  restore(releases[1], restored);
  assert.deepEqual(
    readFileSync(join(restored, backupName, "loop.db")),
    Buffer.from([0, 255, 1, 10]),
  );
  assert.equal(
    readFileSync(join(restored, backupName, "credentials"), "utf8"),
    "fixture credentials\n",
  );
  assert.equal(
    lstatSync(join(restored, backupName, "credentials")).mode & 0o777,
    0o600,
  );
  assert(lstatSync(join(restored, backupName, "empty")).isDirectory());
  assert.equal(
    readlinkSync(join(restored, backupName, "credential-link")),
    "credentials",
  );
  assert.deepEqual(
    readFileSync(join(restored, backupName, "database-hardlink")),
    Buffer.from([0, 255, 1, 10]),
  );
  assert.match(
    readFileSync(join(releases[1], "BACKUP-RESTORE.txt"), "utf8"),
    /directory with:\ntar -xzf/,
  );
  const again = run(root);
  success(again);
  assert.match(again.stdout, /Archived 0 backups/);
});

test("dry-run writes nothing and the retention setting is honored", () => {
  const { root, releases } = fixture();
  const before = readdirSync(root, { recursive: true });
  const result = run(root, "--dry-run", "--keep-unpacked", "1");
  success(result);
  assert.equal(result.stdout.match(/Would archive/g)?.length, 3);
  assert.deepEqual(readdirSync(root, { recursive: true }), before);
  success(run(root, "--keep-unpacked", "1"));
  assert(existsSync(join(releases[3], backupName)));
  assert(
    releases
      .slice(0, 3)
      .every((release) => existsSync(join(release, archiveName))),
  );
});

test("a corrupt existing archive never replaces or removes its source backup", () => {
  const { root, releases } = fixture();
  const archive = join(releases[0], archiveName);
  writeFileSync(archive, "interrupted or corrupt archive");
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Backup archival failed/);
  assert.deepEqual(
    readFileSync(join(releases[0], backupName, "loop.db")),
    Buffer.from([0, 255, 0, 10]),
  );
  assert.equal(readFileSync(archive, "utf8"), "interrupted or corrupt archive");
});

test("a valid archive with different source bytes prevents deletion", () => {
  const { root, releases } = fixture();
  success(run(root));
  const archive = readFileSync(join(releases[0], archiveName));
  restore(releases[0], releases[0]);
  writeFileSync(
    join(releases[0], backupName, "loop.db"),
    Buffer.from([0, 254, 0, 10]),
  );
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Archive contents differ/);
  assert(existsSync(join(releases[0], backupName)));
  assert.deepEqual(readFileSync(join(releases[0], archiveName)), archive);
});

test("incomplete or corrupt gzip trailers preserve the original backup", () => {
  for (const truncated of [true, false]) {
    const { root, releases } = fixture();
    success(run(root));
    restore(releases[0], releases[0]);
    const archive = join(releases[0], archiveName);
    const bytes = readFileSync(archive);
    if (truncated) writeFileSync(archive, bytes.subarray(0, -8));
    else {
      bytes[bytes.length - 8] ^= 0xff;
      writeFileSync(archive, bytes);
    }
    const result = run(root);
    assert.notEqual(
      result.status,
      0,
      "must verify the gzip trailer before deleting the backup",
    );
    assert(existsSync(join(releases[0], backupName, "loop.db")));
  }
});

test("resumes both a partial write and a verified archive left before source removal", () => {
  const { root, releases } = fixture();
  const partial = join(releases[0], archiveName + ".partial");
  writeFileSync(partial, "partial gzip");
  success(run(root));
  assert(!existsSync(partial));
  restore(releases[0], releases[0]);
  const archive = readFileSync(join(releases[0], archiveName));
  success(run(root));
  assert(!existsSync(join(releases[0], backupName)));
  assert.deepEqual(readFileSync(join(releases[0], archiveName)), archive);
});

test("never follows symlinked releases or archive destinations", () => {
  const { root, releases } = fixture();
  const external = fixture(1);
  symlinkSync(
    external.releases[0],
    join(root, "main-20260901T000000Z-abcdef1"),
  );
  const outside = join(external.root, "outside");
  writeFileSync(outside, "leave alone", { mode: 0o644 });
  symlinkSync(outside, join(releases[0], archiveName));
  assert.notEqual(run(root).status, 0);
  assert(existsSync(join(releases[0], backupName)));
  assert.equal(readFileSync(outside, "utf8"), "leave alone");
  assert.equal(lstatSync(outside).mode & 0o777, 0o644);
  assert(existsSync(join(external.releases[0], backupName)));
});

test("rejects missing or extra entries in an existing archive", () => {
  for (const extra of [false, true]) {
    const { root, releases } = fixture();
    const staging = join(root, "staging");
    cpSync(join(releases[0], backupName), join(staging, backupName), {
      recursive: true,
    });
    if (extra) writeFileSync(join(staging, backupName, "extra"), "unexpected");
    else rmSync(join(staging, backupName, "loop.db"));
    const packed = spawnSync(
      "tar",
      ["-czf", join(releases[0], archiveName), "-C", staging, backupName],
      { encoding: "utf8" },
    );
    assert.equal(packed.status, 0, packed.stderr);
    assert.notEqual(run(root).status, 0);
    assert(existsSync(join(releases[0], backupName, "loop.db")));
  }
});

test("an existing archive lock excludes a concurrent invocation", () => {
  const { root, releases } = fixture();
  const result = spawnSync(
    "python3",
    [
      "-c",
      `
import fcntl, pathlib, subprocess, sys
with (pathlib.Path(sys.argv[1]) / '.backup-archive.lock').open('w') as locked:
    fcntl.flock(locked, fcntl.LOCK_EX)
    run = subprocess.run([sys.executable, sys.argv[2], '--releases', sys.argv[1]], capture_output=True, text=True)
    print(run.stderr)
    sys.exit(0 if run.returncode != 0 and 'already running' in run.stderr else 1)
`,
      root,
      script,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert(releases.every((release) => existsSync(join(release, backupName))));
});

test("invalid retention settings fail without changing any backup", () => {
  const { root, releases } = fixture();
  for (const keep of ["0", "-1", "invalid"])
    assert.notEqual(run(root, "--keep-unpacked", keep).status, 0);
  assert(releases.every((release) => existsSync(join(release, backupName))));
});
