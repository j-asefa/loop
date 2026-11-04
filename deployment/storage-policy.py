#!/usr/bin/env python3
"""Explicit host storage budgets and verified deployment-backup retention.

No workspace, agent checkout, upload, session or conversation is a cleanup
candidate. Remote retention is applied only after every selected backup has a
verified copy in the configured backup store. Failed transfers retain local data.
"""
import argparse
from contextlib import contextmanager
import datetime as dt
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import sys
import time

GIB = 1024 ** 3
NAME = re.compile(r"main-(\d{8}T\d{6}Z)-[0-9a-f]{7,40}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")
ARCHIVE = "workspace-backup.tar.gz"


def read_config(path):
    value = json.loads(path.read_text())
    for key in ("releases", "lock", "deploy_lock"):
        if key in value and not Path(value[key]).is_absolute():
            raise ValueError(key + " must be an absolute path")
    return value


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def regular(path):
    s = path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
        raise ValueError("Expected an unlinked regular file: " + str(path))
    return s


def guard(config, extra_bytes=0):
    report = []
    for index, item in enumerate(config["budgets"]):
        path = Path(item["path"])
        if item.get("require_mount") and not path.is_mount():
            raise RuntimeError("Loop state filesystem is not mounted")
        fs = os.statvfs(path)
        free = fs.f_bavail * fs.f_frsize
        minimum = int(item["minimum_free_gib"] * GIB) + (extra_bytes if index == 0 else 0)
        report.append({"path": str(path), "free_gib": round(free / GIB, 2),
                       "minimum_gib": round(minimum / GIB, 2)})
        if free < minimum:
            raise RuntimeError(f"Storage budget: {path} has {free/GIB:.1f} GiB free; "
                               f"{minimum/GIB:.1f} GiB is required. Free build/cache space "
                               "before starting more work; keep Loop state and user files.")
    return report


def needs_budget(program, args):
    if not args or args[0] in ("--version", "-v", "-V", "--help", "-h", "help"):
        return False
    words = [arg for arg in args if not arg.startswith("-")]
    if program == "docker":
        return any(word in {"build", "bake", "pull", "load", "import", "run", "create", "up"}
                   for word in words[:3])
    if program == "npx":
        return True
    return any(word in {"ci", "clean-install", "ic", "install-ci-test", "cit", "install-test",
                        "it", "install", "i", "add", "update", "rebuild", "run", "run-script",
                        "exec", "x", "test", "start", "pack"} for word in words[:3])


@contextmanager
def locked(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        if os.fstat(fd).st_nlink != 1:
            raise RuntimeError("Invalid storage lock")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def release_time(name):
    match = NAME.fullmatch(name)
    if not match:
        raise ValueError("Invalid release name")
    return dt.datetime.strptime(match[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)


def retained(names, daily=7, weekly=4, newest=2):
    """Newest distinct deployment days/weeks, with an unconditional recent floor."""
    if (any(type(n) is not int or n < 0 for n in (daily, weekly, newest))
            or newest < 2):
        raise ValueError("Retention requires nonnegative day/week counts and at least two recent copies")
    names = sorted(names, reverse=True)
    keep = set(names[:newest])
    days, weeks = set(), set()
    for name in names:
        when = release_time(name)
        day, week = when.date(), when.isocalendar()[:2]
        if day not in days and len(days) < daily:
            keep.add(name)
            days.add(day)
        if week not in weeks and len(weeks) < weekly:
            keep.add(name)
            weeks.add(week)
    return keep


def release_directories(root):
    if root.resolve() != root:
        raise ValueError("Release root cannot traverse a symlink")
    result = []
    for p in root.iterdir():
        if not NAME.fullmatch(p.name) or p.is_symlink() or not p.is_dir():
            continue
        # An incomplete deployment never grants cleanup authority.
        try:
            regular(p / "after.json")
            after = json.loads((p / "after.json").read_text())
            if after.get("serverReady") is not True:
                continue
        except (OSError, ValueError):
            continue
        result.append(p)
    return sorted(result, reverse=True)


def archiver():
    spec = importlib.util.spec_from_file_location("loop_backup_archiver",
                         Path(__file__).with_name("archive-backups.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def store_manifest(root):
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    if root.resolve() != root:
        raise ValueError("Backup store cannot traverse a symlink")
    entries = {}
    for p in root.iterdir():
        if not NAME.fullmatch(p.name) or not p.is_dir() or p.is_symlink():
            continue
        try:
            regular(p / "receipt.json")
            receipt = json.loads((p / "receipt.json").read_text())
            s = regular(p / ARCHIVE)
            if receipt.get("bytes") != s.st_size or not SHA.fullmatch(receipt.get("sha256", "")):
                raise ValueError("Invalid receipt")
            entries[p.name] = receipt
        except (OSError, ValueError):
            continue
    return entries


def accept_backup(root, name, expected):
    release_time(name)
    if not SHA.fullmatch(expected):
        raise ValueError("Invalid checksum")
    folder = root / name
    if folder.resolve() != folder or not folder.is_dir():
        raise ValueError("Invalid backup destination")
    complete, partial = folder / ARCHIVE, folder / (ARCHIVE + ".partial")
    source = partial if partial.exists() else complete
    info = regular(source)
    if digest(source) != expected:
        raise RuntimeError("Transferred backup checksum mismatch; original retained")
    source.chmod(0o600)
    with source.open("rb") as stream:
        os.fsync(stream.fileno())
    if source != complete:
        os.replace(source, complete)
    receipt = {"sha256": expected, "bytes": info.st_size}
    temp = folder / "receipt.json.partial"
    with temp.open("w") as stream:
        json.dump(receipt, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temp.chmod(0o600)
    os.replace(temp, folder / "receipt.json")
    fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return receipt


class RemoteStore:
    def __init__(self, config):
        self.host, self.root = config["host"], config["root"]
        self.script = config["script"]
        self.ssh = ["ssh", "-F", config["ssh_config"], "-o", "BatchMode=yes", self.host]
        self.rsync_shell = shlex.join(self.ssh[:-1])

    def call(self, action, *args):
        cmd = shlex.join(["python3", self.script, "store", "--root", self.root, action, *args])
        return json.loads(subprocess.check_output(self.ssh + [cmd], text=True, timeout=600))

    def sync(self, name, archive):
        expected = digest(archive)
        manifest = self.call("list")
        # Even an existing receipt is revalidated against stored bytes before deletion here.
        if manifest.get(name, {}).get("sha256") != expected:
            self.call("prepare", name)
            target = f"{self.host}:{self.root}/{name}/{ARCHIVE}.partial"
            subprocess.run(["rsync", "-a", "--partial", "--append-verify", "--chmod=F600",
                            "-e", self.rsync_shell, str(archive), target], check=True, timeout=1800)
        receipt = self.call("accept", name, expected)
        if receipt != {"sha256": expected, "bytes": archive.stat().st_size}:
            raise RuntimeError("Remote backup receipt does not match the local archive")
        return receipt


def store_action(root, action, args):
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    if root.resolve() != root:
        raise ValueError("Backup root contains a symlink")
    with locked(root / ".store.lock"):
        if action == "list":
            return store_manifest(root)
        if action == "prepare":
            release_time(args[0])
            p = root / args[0]
            p.mkdir(mode=0o700, exist_ok=True)
            if p.resolve() != p:
                raise ValueError("Backup destination contains a symlink")
            return {"prepared": args[0]}
        if action == "accept":
            return accept_backup(root, *args)
        if action == "prune":
            keep = set(args)
            entries = store_manifest(root)
            if not keep or len(keep) < min(2, len(entries)) or not keep.issubset(entries):
                raise RuntimeError("Retained backup set is incomplete; nothing expires")
            for name in keep:
                receipt = entries[name]
                if digest(root / name / ARCHIVE) != receipt["sha256"]:
                    raise RuntimeError("Retained backup is corrupt; nothing expires")
            expired = []
            for name in sorted(set(entries) - keep):
                # Unknown files are not owned by this retention policy.
                p = root / name
                if set(x.name for x in p.iterdir()) != {ARCHIVE, "receipt.json"}:
                    continue
                shutil.rmtree(p)
                expired.append(name)
            return {"expired": expired}
    raise ValueError("Unknown backup store action")


def process_start(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def cleanup_fixtures(root, days=7, now=None):
    now = time.time() if now is None else now
    removed = []
    root = root.resolve()
    for p in root.glob("loop-package-*"):
        if p.is_symlink() or not p.is_dir() or p.resolve().parent != root:
            continue
        marker = p / ".loop-disposable.json"
        try:
            regular(marker)
            m, s = json.loads(marker.read_text()), p.lstat()
            if (m.get("kind") != "package-smoke" or m.get("version") != 1
                    or m.get("uid") != os.getuid() or s.st_uid != os.getuid()
                    or m.get("inode") != s.st_ino or m.get("device") != s.st_dev
                    or now - m["created"] < days * 86400):
                continue
            if process_start(m["pid"]) == m.get("process_start"):
                continue
            if m.get("process_group"):
                try:
                    os.killpg(m["process_group"], 0)
                    continue
                except ProcessLookupError:
                    pass
                except PermissionError:
                    continue
            safe = True
            for directory, dirs, files in os.walk(p, followlinks=False):
                for name in dirs + files:
                    f = Path(directory) / name
                    info = f.lstat()
                    if info.st_dev != s.st_dev or now - info.st_mtime < days * 86400:
                        safe = False
                        break
                if not safe:
                    break
            if safe:
                shutil.rmtree(p)
                removed.append(str(p))
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return removed


def release_is_unmodified(source):
    """Allow only the deterministic metadata edits made by the deploy packer."""
    if not (source / ".git").is_file() or source.is_symlink():
        return False
    try:
        status = subprocess.check_output(["git", "-C", str(source), "status", "--porcelain=v1",
                                          "--untracked-files=all"], text=True, timeout=30)
        for line in status.splitlines():
            if line not in ("?? npm-shrinkwrap.json", " M package.json"):
                return False
        shrink = source / "npm-shrinkwrap.json"
        if shrink.exists() and shrink.read_bytes() != (source / "package-lock.json").read_bytes():
            return False
        original = json.loads(subprocess.check_output(
            ["git", "-C", str(source), "show", "HEAD:package.json"], text=True, timeout=10))
        current = json.loads((source / "package.json").read_text())
        if current == original:
            return True
        extra = "src/native-auth/pi-customizations.ts"
        expected = dict(original)
        expected["files"] = [*original.get("files", []), extra]
        return extra not in original.get("files", []) and current == expected
    except (OSError, ValueError, subprocess.SubprocessError):
        return False


def busy_sources(sources, uid=None):
    """A live process reference prevents removing its deployment dependencies."""
    uid = os.getuid() if uid is None else uid
    busy = set()
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            if proc.stat().st_uid != uid:
                continue
            references = [str((proc / "cwd").readlink()), (proc / "cmdline").read_bytes().decode(errors="replace"),
                          (proc / "maps").read_text(errors="replace")]
            for fd in (proc / "fd").iterdir():
                try:
                    references.append(str(fd.readlink()))
                except FileNotFoundError:
                    pass
            for source in sources:
                if any(str(source) in value for value in references):
                    busy.add(source)
        except FileNotFoundError:
            continue
        except PermissionError:
            # Incomplete inspection cannot authorize deleting a dependency tree.
            return set(sources)
    return busy


def prune_builds(releases, config):
    protected = set(releases[:2])
    deployed = config.get("deployed_tools")
    if deployed:
        resolved = Path(deployed).resolve()
        protected.update(p for p in releases if resolved == p / "source/deployment")
    sources = [p / "source" for p in releases if p not in protected]
    inspector = config.get("process_inspector")
    if inspector and sources:
        # Only process inspection is privileged; all deletion stays unprivileged.
        result = subprocess.check_output(
            ["sudo", "-n", "/usr/bin/python3", inspector, "inspect-processes",
             "--uid", str(os.getuid())], input=json.dumps(list(map(str, sources))),
            text=True, timeout=60)
        busy = {Path(value) for value in json.loads(result)}
        if not busy.issubset(sources):
            raise RuntimeError("Unexpected process inspection result")
    else:
        busy = busy_sources(sources)
    removed = []
    for p in releases:
        if p in protected:
            continue
        source = p / "source"
        if source in busy or not release_is_unmodified(source):
            continue
        modules = source / "node_modules"
        if modules.is_dir() and not modules.is_symlink():
            try:
                receipt = json.loads((modules / ".package-lock.json").read_text())
                lock = json.loads((source / "package-lock.json").read_text())
                packages = receipt.get("packages", {})
                if not packages or any(
                    not name.startswith("node_modules/") or entry.get("link")
                    or any(entry.get(k) != lock.get("packages", {}).get(name, {}).get(k)
                           for k in ("version", "resolved", "integrity"))
                    for name, entry in packages.items()):
                    continue
            except (OSError, ValueError):
                continue
            shutil.rmtree(modules)
            removed.append(str(modules))
        for package in p.glob("j-asefa-loop-*.tgz"):
            if package.exists():
                regular(package)
                package.unlink()
                removed.append(str(package))
    return removed


def maintain(config, dry_run=False, store=None):
    root = Path(config["releases"])
    releases = release_directories(root)
    linked = {(p / "workspace-backup").resolve() for p in root.iterdir()
              if p.is_dir() and (p / "workspace-backup").is_symlink()}
    backups = [p for p in releases if not (p / "workspace-backup").is_symlink()
               and (p / "workspace-backup").resolve() not in linked
               and ((p / ARCHIVE).is_file() or (p / "workspace-backup").is_dir())]
    remote = store or RemoteStore(config["backup_store"])
    existing = remote.call("list")
    policy = config.get("retention", {})
    keep = retained(set(existing) | {p.name for p in backups}, **policy)
    local_keep = {p.name for p in backups[:2]}
    summary = {"retain_remote": sorted(keep), "retain_local": sorted(local_keep),
               "expire_local_backups": [p.name for p in backups if p.name not in local_keep]}
    if dry_run:
        return summary
    if not backups:
        return {"skipped": "No completed deployment backups"}
    module = archiver()
    with module.archive_lock(root):
        for index, p in enumerate(backups):
            if p.name not in keep and p.name not in local_keep:
                continue
            source = p / "workspace-backup"
            if source.is_symlink() or (p / ARCHIVE).is_symlink():
                raise RuntimeError("Linked backup cannot be managed automatically")
            if source.is_dir():
                # Reserve enough staging room for a worst-case incompressible archive.
                total = sum(f.stat().st_size for f in source.rglob("*")
                            if f.is_file() and not f.is_symlink())
                guard(config, total)
                module.archive_backup(source, retain_source=index == 0)
            if p.name in keep:
                remote.sync(p.name, p / ARCHIVE)
        acknowledged = remote.call("list")
        if not keep.issubset(acknowledged):
            raise RuntimeError("Backup destination is incomplete; local history retained")
        # Verify the complete retained set before either side expires any history.
        remote.call("prune", *sorted(keep))
        expired = []
        for p in backups:
            if p.name in local_keep:
                continue
            source, archive = p / "workspace-backup", p / ARCHIVE
            if source.is_symlink() or archive.is_symlink():
                continue
            if source.is_dir():
                # Only the archiver removes expanded backup trees after verification.
                module.archive_backup(source)
            if archive.exists():
                regular(archive)
                archive.unlink()
                (p / "BACKUP-RESTORE.txt").write_text(
                    "Local backup expired under the configured retention policy.\n"
                    "Retained recovery points are on the configured backup VM.\n")
                expired.append(p.name)
    summary["expired_local_backups"] = expired
    summary["build_artifacts_removed"] = prune_builds(releases, config)
    summary["fixtures_removed"] = cleanup_fixtures(Path(config.get("temporary_root", "/tmp")))
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    for action in ("guard", "maintain", "exec"):
        p = sub.add_parser(action)
        p.add_argument("--config", type=Path, required=True)
        if action == "guard":
            p.add_argument("--extra-bytes", type=int, default=0)
        elif action == "maintain":
            p.add_argument("--dry-run", action="store_true")
        else:
            p.add_argument("--program", required=True, choices=["npm", "npx", "docker"])
            p.add_argument("--executable", required=True)
            p.add_argument("args", nargs=argparse.REMAINDER)
    p = sub.add_parser("inspect-processes")
    p.add_argument("--uid", type=int, required=True)
    p = sub.add_parser("store")
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("operation", choices=["list", "prepare", "accept", "prune"])
    p.add_argument("args", nargs="*")
    args = parser.parse_args()
    if args.action == "inspect-processes":
        paths = [Path(value) for value in json.load(sys.stdin)]
        result = sorted(str(p) for p in busy_sources(paths, args.uid))
    elif args.action == "store":
        result = store_action(args.root, args.operation, args.args)
    else:
        config = read_config(args.config)
        if args.action == "guard":
            result = guard(config, args.extra_bytes)
        elif args.action == "exec":
            arguments = args.args[1:] if args.args[:1] == ["--"] else args.args
            if needs_budget(args.program, arguments):
                guard(config)
            os.execv(args.executable, [args.executable, *arguments])
        else:
            with locked(Path(config["lock"])), locked(Path(config["deploy_lock"])):
                result = maintain(config, args.dry_run)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print("Loop storage: " + str(error), file=sys.stderr)
        raise SystemExit(1)
