import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  HARNESS_CREDENTIALS,
  INSTALL_SCRIPT,
  initScript,
} from "../src/server/vm/sailbox-image.js";

// Runs the experiment init script on this machine against temporary
// directories. The install script itself is only syntax-checked here; it has
// not been run on a Sailbox by this test.

function run(home: string, auth: string, workspace: string) {
  const script = join(home, "loop-vm-init");
  writeFileSync(script, initScript(), { mode: 0o755 });
  execFileSync("bash", [script], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      LOOP_AUTH_MOUNT: auth,
      LOOP_WORKSPACE: workspace,
      // The fixture's auth directory is not a mount point.
      LOOP_AUTH_SKIP_MOUNT_CHECK: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
}

it("links only credential files to the auth volume and initialises the workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-vm-init-"));
  const [home, auth, workspace] = ["home", "auth", "workspace"].map((name) =>
    join(root, name),
  );
  mkdirSync(home);
  mkdirSync(auth);
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex/auth.json"), "earlier");
  mkdirSync(join(home, ".claude/projects"), { recursive: true });

  run(home, auth, workspace);
  run(home, auth, workspace);

  for (const [harness, files] of Object.entries(HARNESS_CREDENTIALS))
    for (const file of files) {
      const path = join(home, file);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(readlinkSync(path).startsWith(join(auth, harness))).toBe(true);
    }
  // A credential written before the volume was linked moves onto it.
  expect(readFileSync(join(auth, "codex/auth.json"), "utf8")).toBe("earlier");
  // Session directories stay on the VM's own disk.
  expect(lstatSync(join(home, ".claude/projects")).isSymbolicLink()).toBe(
    false,
  );
  expect(existsSync(join(auth, "claude/projects"))).toBe(false);
  const log = execFileSync("git", ["log", "--format=%s"], {
    cwd: workspace,
    encoding: "utf8",
  });
  expect(log.trim()).toBe("Initial experiment workspace");
});

it("produces an install script bash accepts", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-vm-install-"));
  writeFileSync(join(dir, "install.sh"), INSTALL_SCRIPT);
  execFileSync("bash", ["-n", join(dir, "install.sh")]);
});

it("keeps a credential the harness refreshed by replacing its link", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-vm-refresh-"));
  const [home, auth, workspace] = ["home", "auth", "workspace"].map((name) =>
    join(root, name),
  );
  mkdirSync(home);
  mkdirSync(auth);
  run(home, auth, workspace);
  writeFileSync(join(auth, "codex/auth.json"), "old token");
  // The harness writes a new file in place of the link, as an atomic
  // rename-based refresh does.
  const path = join(home, ".codex/auth.json");
  rmSync(path);
  writeFileSync(path, "refreshed token");

  run(home, auth, workspace);

  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(readFileSync(path, "utf8")).toBe("refreshed token");
  expect(readFileSync(join(auth, "codex/auth.json"), "utf8")).toBe(
    "refreshed token",
  );
});

it("refuses to place credentials when the auth volume is not mounted", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-vm-unmounted-"));
  const [home, auth, workspace] = ["home", "auth", "workspace"].map((name) =>
    join(root, name),
  );
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(auth);
  writeFileSync(join(home, ".codex/auth.json"), "token");
  const script = join(root, "loop-vm-init");
  writeFileSync(script, initScript(), { mode: 0o755 });
  expect(() =>
    execFileSync("bash", [script], {
      stdio: "pipe",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        LOOP_AUTH_MOUNT: auth,
        LOOP_WORKSPACE: workspace,
      },
    }),
  ).toThrow(/is not mounted/);
  expect(readFileSync(join(home, ".codex/auth.json"), "utf8")).toBe("token");
  expect(existsSync(join(auth, "codex"))).toBe(false);
});

it("finishes the initial commit when an earlier run stopped after git init", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-vm-unborn-"));
  const [home, auth, workspace] = ["home", "auth", "workspace"].map((name) =>
    join(root, name),
  );
  mkdirSync(home);
  mkdirSync(auth);
  mkdirSync(workspace);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
  run(home, auth, workspace);
  expect(
    execFileSync("git", ["log", "--format=%s"], {
      cwd: workspace,
      encoding: "utf8",
    }).trim(),
  ).toBe("Initial experiment workspace");
});
