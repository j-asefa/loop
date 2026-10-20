#!/usr/bin/env python3
"""Compress immutable deployment backups after a successful deployment.

Requires Python 3.9+ on Linux/macOS. Only direct main-TIMESTAMP-COMMIT release
directories in the explicitly supplied root are considered. No backup expires.
"""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tarfile
import tempfile


RELEASE_NAME = re.compile(r"main-\d{8}T\d{6}Z-[0-9a-f]{7,40}\Z")
BACKUP = "workspace-backup"
ARCHIVE = BACKUP + ".tar.gz"


def snapshot(backup):
    """Record entry identity without traversing symlinked directories."""
    paths = [backup]
    for directory, dirs, files in os.walk(backup, followlinks=False):
        paths.extend(Path(directory) / name for name in dirs + files)
    result = {}
    for path in paths:
        info = path.lstat()
        if not any(check(info.st_mode) for check in
                   (stat.S_ISREG, stat.S_ISDIR, stat.S_ISLNK)):
            raise RuntimeError(f"Unsupported backup entry: {path}")
        result[path.relative_to(backup.parent).as_posix()] = (
            info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns, info.st_uid, info.st_gid,
        )
    return result


def digest(stream):
    value = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        value.update(chunk)
    return value.digest()


def verify(archive, backup, expected):
    seen = set()
    with tarfile.open(archive, "r:gz") as saved:
        for member in saved:
            if member.name not in expected or member.name in seen:
                raise RuntimeError(f"Unexpected or duplicate archive entry: {member.name}")
            seen.add(member.name)
            original = backup.parent / member.name
            info = original.lstat()
            if (member.mode != stat.S_IMODE(info.st_mode)
                    or member.uid != info.st_uid or member.gid != info.st_gid):
                raise RuntimeError(f"Archive metadata differs: {member.name}")
            if member.isfile() or member.islnk():
                if not stat.S_ISREG(info.st_mode):
                    raise RuntimeError(f"Backup file changed: {member.name}")
                if member.islnk():
                    # A hard link must resolve to a regular file within this backup.
                    if (member.linkname not in expected
                            or not saved.getmember(member.linkname).isfile()):
                        raise RuntimeError(f"Invalid archive hard link: {member.name}")
                elif member.size != info.st_size:
                    raise RuntimeError(f"Archive size differs: {member.name}")
                with original.open("rb") as current, saved.extractfile(member) as packed:
                    if digest(current) != digest(packed):
                        raise RuntimeError(f"Archive contents differ: {member.name}")
            elif member.isdir():
                if not stat.S_ISDIR(info.st_mode):
                    raise RuntimeError(f"Backup directory changed: {member.name}")
            elif member.issym():
                if not stat.S_ISLNK(info.st_mode) or os.readlink(original) != member.linkname:
                    raise RuntimeError(f"Backup symlink changed: {member.name}")
            else:
                raise RuntimeError(f"Unsupported archive entry: {member.name}")
        # Tar iteration stops at its end marker, before gzip necessarily checks
        # its trailer. Consume the rest so truncation and CRC errors also fail.
        while saved.fileobj.read(1024 * 1024):
            pass
    if seen != set(expected) or snapshot(backup) != expected:
        raise RuntimeError("Backup changed or archive entries are missing")


def require_private_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise RuntimeError(f"Expected a regular archive file with one link: {path}")
    path.chmod(0o600)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def archive_backup(backup):
    expected = snapshot(backup)
    archive = backup.parent / ARCHIVE
    partial = backup.parent / (ARCHIVE + ".partial")
    if os.path.lexists(archive):
        require_private_file(archive)
        verify(archive, backup, expected)
    else:
        # A killed writer leaves only a partial archive and its original backup.
        if os.path.lexists(partial):
            require_private_file(partial)
            partial.unlink()
        fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as output:
                with tarfile.open(fileobj=output, mode="w:gz", compresslevel=3,
                                  dereference=False) as saved:
                    saved.add(backup, arcname=BACKUP)
                output.flush()
                os.fsync(output.fileno())
            verify(partial, backup, expected)
            os.replace(partial, archive)
        except BaseException:
            partial.unlink(missing_ok=True)
            raise
    # Make the verified archive durable before removing its expanded source.
    with archive.open("rb") as stored:
        os.fsync(stored.fileno())
    sync_directory(backup.parent)
    note = (
        "This full deployment backup was compressed and verified byte for byte.\n"
        "Restore into this release directory with:\n"
        "tar -xzf workspace-backup.tar.gz\n"
        "The workspace-backup directory will be recreated with its original files.\n"
    )
    fd, temporary = tempfile.mkstemp(prefix=".backup-restore-", dir=backup.parent)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(note)
        os.replace(temporary, backup.parent / "BACKUP-RESTORE.txt")
    finally:
        Path(temporary).unlink(missing_ok=True)
    if snapshot(backup) != expected:
        raise RuntimeError("Backup changed before removal; original retained")
    shutil.rmtree(backup)


@contextmanager
def archive_lock(root):
    fd = os.open(root / ".backup-archive.lock",
                 os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError("Invalid backup archive lock file")
        os.fchmod(fd, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another backup archiver is already running") from None
        yield
    finally:
        os.close(fd)


def candidates(root, keep):
    releases = sorted(
        (p for p in root.iterdir()
         if RELEASE_NAME.fullmatch(p.name) and p.is_dir() and not p.is_symlink()),
        reverse=True,
    )
    protected = {(p / BACKUP).resolve() for p in releases if (p / BACKUP).is_symlink()}
    backups = [p / BACKUP for p in releases
               if (p / BACKUP).is_dir() and not (p / BACKUP).is_symlink()]
    return [backup for backup in backups[keep:] if backup.resolve() not in protected]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--releases", required=True, type=Path,
                        help="Directory containing immutable main-TIMESTAMP-COMMIT releases")
    parser.add_argument("--keep-unpacked", type=int, default=3,
                        help="Number of newest expanded backups to retain (default: 3)")
    parser.add_argument("--dry-run", action="store_true", help="List candidates without writing")
    args = parser.parse_args()
    if args.keep_unpacked < 1:
        parser.error("--keep-unpacked must be at least 1")
    root = args.releases.expanduser().resolve(strict=True)
    if not root.is_dir():
        parser.error("--releases must name an existing directory")
    os.umask(0o077)
    if args.dry_run:
        for backup in candidates(root, args.keep_unpacked):
            print(f"Would archive {backup.parent.name}")
        return
    with archive_lock(root):
        count = 0
        for backup in candidates(root, args.keep_unpacked):
            archive_backup(backup)
            count += 1
            print(f"Archived {backup.parent.name}", flush=True)
        print(f"Archived {count} backups. All backup contents retained.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, EOFError, RuntimeError, tarfile.TarError) as error:
        print(f"Backup archival failed: {error}", file=sys.stderr)
        sys.exit(1)
