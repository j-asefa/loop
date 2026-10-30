import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("policy", ROOT / "deployment/storage-policy.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class LocalTransport:
    """Exercise the production receiver without SSH in deterministic fixtures."""
    def __init__(self, root, corrupt=False):
        self.root, self.corrupt = root, corrupt

    def call(self, action, *args):
        return p.store_action(self.root, action, args)

    def sync(self, name, archive):
        self.call("prepare", name)
        target = self.root / name / (p.ARCHIVE + ".partial")
        shutil.copyfile(archive, target)
        if self.corrupt:
            with target.open("ab") as f:
                f.write(b"broken transport")
        return self.call("accept", name, p.digest(archive))


class StoragePolicy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="loop55-storage-policy-")
        self.root = Path(self.temp.name)
        self.releases = self.root / "releases"
        self.releases.mkdir()
        self.store = LocalTransport(self.root / "backup-vm")
        self.config = {"releases": str(self.releases),
                       "budgets": [{"path": str(self.root), "minimum_free_gib": 0}],
                       "retention": {"daily": 2, "weekly": 1, "newest": 2},
                       "temporary_root": str(self.root / "tmp")}
        (self.root / "tmp").mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def release(self, day):
        folder = self.releases / f"main-202610{day:02}T000000Z-abcdef1"
        (folder / "workspace-backup").mkdir(parents=True)
        (folder / "workspace-backup/loop55.db").write_bytes(bytes([day]) * 1000)
        (folder / "after.json").write_text('{"serverReady":true}')
        return folder

    def test_retention_bounded_by_distinct_days_and_weeks(self):
        names = []
        start = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
        for day in range(120):
            for hour in (1, 12, 23):
                when = start + dt.timedelta(days=day, hours=hour)
                names.append("main-" + when.strftime("%Y%m%dT%H%M%SZ") + "-abcdef1")
        keep = p.retained(names)
        self.assertLessEqual(len(keep), 13)
        self.assertTrue(set(sorted(names)[-2:]).issubset(keep))
        self.assertNotIn(names[0], keep)

    def test_invalid_retention_cannot_authorize_pruning(self):
        for policy in ({"newest": 0}, {"weekly": -1}, {"daily": 2.5}):
            with self.assertRaises(ValueError):
                p.retained(["main-20261001T000000Z-abcdef1"], **policy)

    def test_maintenance_verifies_remote_before_expiring_local_history(self):
        releases = [self.release(day) for day in range(1, 6)]
        user = self.root / "real-project"
        user.mkdir()
        (user / "work.txt").write_text("uncommitted work")
        result = p.maintain(self.config, store=self.store)
        self.assertEqual(len(result["expired_local_backups"]), 3)
        self.assertTrue((releases[-1] / "workspace-backup/loop55.db").exists())
        self.assertTrue((releases[-1] / p.ARCHIVE).exists())
        self.assertFalse((releases[-2] / "workspace-backup").exists())
        self.assertTrue((releases[-2] / p.ARCHIVE).exists())
        remote = self.store.call("list")
        self.assertEqual(set(remote), {r.name for r in releases[-2:]})
        for name, receipt in remote.items():
            self.assertEqual(p.digest(self.store.root / name / p.ARCHIVE), receipt["sha256"])
        self.assertEqual((user / "work.txt").read_text(), "uncommitted work")
        # Running again must preserve the same recovery points.
        p.maintain(self.config, store=self.store)
        self.assertEqual(self.store.call("list"), remote)

    def test_corrupt_transfer_never_expires_local_backups(self):
        releases = [self.release(day) for day in range(1, 5)]
        broken = LocalTransport(self.store.root, corrupt=True)
        with self.assertRaisesRegex(RuntimeError, "checksum"):
            p.maintain(self.config, store=broken)
        for release in releases:
            self.assertTrue((release / "workspace-backup").exists() or (release / p.ARCHIVE).exists())
        self.assertEqual(self.store.call("list"), {})

    def test_corrupt_retained_copy_prevents_remote_pruning(self):
        releases = [self.release(day) for day in range(1, 4)]
        for release in releases:
            p.archiver().archive_backup(release / "workspace-backup")
            self.store.sync(release.name, release / p.ARCHIVE)
        (self.store.root / releases[-1].name / p.ARCHIVE).write_bytes(b"corrupted")
        with self.assertRaises(RuntimeError):
            self.store.call("prune", *(r.name for r in releases[-2:]))
        self.assertTrue((self.store.root / releases[0].name / p.ARCHIVE).exists())

    def test_dry_run_does_not_archive_or_delete(self):
        releases = [self.release(day) for day in range(1, 4)]
        result = p.maintain(self.config, dry_run=True, store=self.store)
        self.assertIn(releases[0].name, result["expire_local_backups"])
        for release in releases:
            self.assertTrue((release / "workspace-backup").exists())
            self.assertFalse((release / p.ARCHIVE).exists())

    def test_incomplete_and_linked_backups_are_retained(self):
        releases = [self.release(day) for day in range(1, 5)]
        (releases[0] / "after.json").unlink()
        alias = self.releases / "main-20261005T000000Z-abcdef1"
        alias.mkdir()
        (alias / "workspace-backup").symlink_to(releases[1] / "workspace-backup")
        p.maintain(self.config, store=self.store)
        self.assertTrue((releases[0] / "workspace-backup/loop55.db").exists())
        self.assertTrue((releases[1] / "workspace-backup/loop55.db").exists())

    def test_guard_blocks_work_without_touching_existing_data(self):
        config = self.root / "policy.json"
        config.write_text(json.dumps({"budgets": [{"path": str(self.root), "minimum_free_gib": 10**12}]}))
        result = subprocess.run(["python3", str(ROOT / "deployment/storage-policy.py"),
                                 "guard", "--config", str(config)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Storage budget", result.stderr)
        self.assertTrue(config.exists())

    def test_guard_requires_actual_state_mount(self):
        config = {"budgets": [{"path": str(self.root), "minimum_free_gib": 0, "require_mount": True}]}
        with self.assertRaisesRegex(RuntimeError, "not mounted"):
            p.guard(config)

    def test_read_only_commands_remain_available_under_pressure(self):
        for program, args in [("npm", ["--version"]), ("npm", ["cache", "clean", "--force"]),
                              ("docker", ["system", "prune"]), ("docker", ["ps"]), ("npx", ["--version"])]:
            self.assertFalse(p.needs_budget(program, args))
        for program, args in [("npm", ["ci"]), ("npm", ["run", "build"]),
                              ("docker", ["buildx", "build", "."]), ("docker", ["compose", "up"]),
                              ("npx", ["vitest", "run"]), ("npm", ["--prefix", "/tmp/project", "ci"])]:
            self.assertTrue(p.needs_budget(program, args))

    def fixture(self, name="loop55-package-expired", live=False):
        folder = self.root / "tmp" / name
        folder.mkdir()
        info = folder.stat()
        old = time.time() - 9 * 86400
        marker = {"version": 1, "kind": "package-smoke", "created": old, "uid": os.getuid(),
                  "inode": info.st_ino, "device": info.st_dev,
                  "pid": os.getpid() if live else 99999999,
                  "process_start": p.process_start(os.getpid()) if live else "not-running"}
        (folder / ".loop55-disposable.json").write_text(json.dumps(marker))
        (folder / "generated.txt").write_text("fixture")
        for child in folder.iterdir():
            os.utime(child, (old, old))
        return folder

    def test_only_explicit_expired_fixture_is_removed(self):
        expired = self.fixture()
        unmarked = self.root / "tmp/loop55-package-user"
        unmarked.mkdir()
        (unmarked / "notes.txt").write_text("user work")
        live = self.fixture("loop55-package-live", live=True)
        recent = self.fixture("loop55-package-recent-edit")
        (recent / "generated.txt").write_text("new work")
        self.assertEqual(p.cleanup_fixtures(self.root / "tmp"), [str(expired)])
        self.assertTrue(unmarked.exists())
        self.assertTrue(live.exists())
        self.assertTrue(recent.exists())

    def test_copied_marker_and_symlink_do_not_authorize_cleanup(self):
        original = self.fixture()
        copied = self.root / "tmp/loop55-package-copied"
        shutil.copytree(original, copied)
        link = self.root / "tmp/loop55-package-link"
        link.symlink_to(original, target_is_directory=True)
        p.cleanup_fixtures(self.root / "tmp")
        self.assertTrue(copied.exists())
        self.assertTrue(link.is_symlink())

    def test_marker_helper_records_actual_fixture_identity(self):
        folder = self.root / "tmp/loop55-package-node"
        folder.mkdir()
        code = "import {markDisposableFixture} from " + json.dumps(
            (ROOT / "scripts/helpers/disposable-fixture.mjs").as_uri()) + ";markDisposableFixture(process.argv[1]);"
        subprocess.run(["node", "--input-type=module", "-e", code, str(folder)], check=True)
        marker = json.loads((folder / ".loop55-disposable.json").read_text())
        self.assertEqual(marker["inode"], folder.stat().st_ino)
        self.assertEqual(marker["kind"], "package-smoke")
        self.assertEqual(p.cleanup_fixtures(self.root / "tmp"), [])

    def build_source(self, release):
        repo = self.root / "repo"
        if not repo.exists():
            repo.mkdir()
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            (repo / ".gitignore").write_text("node_modules/\n")
            (repo / "package.json").write_text('{"name":"fixture","version":"0.1.0"}')
            lock = {"lockfileVersion": 3, "packages": {"node_modules/pkg": {
                "version": "1", "resolved": "https://registry.npmjs.org/pkg/-/pkg-1.tgz",
                "integrity": "sha512-fixture"}}}
            (repo / "package-lock.json").write_text(json.dumps(lock))
            subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
            subprocess.run(["git", "-C", str(repo), "-c", "user.name=Fixture", "-c",
                            "user.email=fixture@example.test", "commit", "-qm", "fixture"], check=True)
        source = release / "source"
        subprocess.run(["git", "-C", str(repo), "worktree", "add", "--quiet", "--detach", str(source)], check=True)
        (source / "node_modules/pkg").mkdir(parents=True)
        shutil.copyfile(source / "package-lock.json", source / "node_modules/.package-lock.json")
        shutil.copyfile(source / "package-lock.json", source / "npm-shrinkwrap.json")
        (release / "loop55-0.1.0.tgz").write_bytes(b"generated package")
        return source

    def test_prunes_only_old_unmodified_inactive_release_artifacts(self):
        releases = [self.release(day) for day in range(1, 5)]
        sources = [self.build_source(release) for release in releases]
        (sources[1] / "user-notes.txt").write_text("keep this work")
        with patch.object(p, "busy_sources", return_value=set()):
            removed = p.prune_builds(list(reversed(releases)), self.config)
        self.assertIn(str(sources[0] / "node_modules"), removed)
        self.assertTrue((sources[0] / "package.json").exists())
        for source in sources[1:]:
            self.assertTrue((source / "node_modules").is_dir())

    def test_uninspectable_process_protects_all_builds(self):
        sources = [self.root / "one", self.root / "two"]
        with patch.object(Path, "readlink", side_effect=PermissionError("restricted proc")):
            self.assertEqual(p.busy_sources(sources), set(sources))

    def test_live_process_prevents_old_release_dependency_removal(self):
        releases = [self.release(day) for day in range(1, 4)]
        source = self.build_source(releases[0])
        previous = Path.cwd()
        try:
            os.chdir(source)
            self.assertEqual(p.prune_builds(list(reversed(releases)), self.config), [])
        finally:
            os.chdir(previous)
        self.assertTrue((source / "node_modules").exists())

    def test_deployed_release_is_protected_even_with_newer_builds(self):
        releases = [self.release(day) for day in range(1, 4)]
        source = self.build_source(releases[0])
        tools = source / "deployment"
        tools.mkdir()
        link = self.root / "deployed-tools"
        link.symlink_to(tools)
        self.config["deployed_tools"] = str(link)
        self.assertEqual(p.prune_builds(list(reversed(releases)), self.config), [])
        self.assertTrue((source / "node_modules").exists())


if __name__ == "__main__":
    unittest.main()
