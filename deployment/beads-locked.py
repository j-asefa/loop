"""Hold a per-store kernel lock across exec into the embedded Dolt process."""
import fcntl
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import uuid


def acquire():
    fd = os.open(".loop-beads.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        sys.exit("LOOP_BEADS_NOT_STARTED")
    deadline = time.monotonic() + 15
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if time.monotonic() >= deadline:
                sys.exit("LOOP_BEADS_NOT_STARTED")
            time.sleep(0.05)
        else:
            break

    return fd


def installed(destination, expected):
    digest = hashlib.sha256()
    try:
        fd = os.open(destination, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            return False
        with os.fdopen(fd, "rb") as binary:
            for chunk in iter(lambda: binary.read(1024 * 1024), b""):
                digest.update(chunk)
            return digest.hexdigest() == expected
    except OSError:
        # Invalid or unreadable cache entries are replaced only from verified staging.
        return False


def publish(source, destination, expected):
    # All Loop installers use this directory's lock before changing the
    # published inode or its mode. Downloads stage outside the critical section.
    if installed(destination, expected):
        if os.access(destination, os.X_OK):
            return
        info = os.stat(destination, follow_symlinks=False)
        if info.st_uid == os.geteuid() and not info.st_mode & stat.S_IXUSR:
            os.chmod(destination, 0o700)
            if os.access(destination, os.X_OK):
                return
    if not source:
        sys.exit("LOOP_BEADS_NOT_STARTED")
    if os.path.isdir(destination) and not os.path.islink(destination):
        # Preserve unexpected directory contents. A file cannot replace a
        # directory, so move it aside under the same publication lock.
        rejected = tempfile.mkdtemp(prefix=".rejected-bd-", dir=os.path.dirname(destination))
        os.rename(destination, os.path.join(rejected, "bd"))
    os.replace(source, destination)


def file_stamp(info):
    if not stat.S_ISREG(info.st_mode):
        return None
    return ":".join(str(value) for value in (
        info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
    ))


def open_verified(path, expected):
    executable = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    if file_stamp(os.fstat(executable)) != expected:
        sys.exit("LOOP_BEADS_NOT_STARTED")
    return executable


def executable_target(path, expected, executable):
    if executable is None:
        return path
    if file_stamp(os.fstat(executable)) != expected:
        sys.exit("LOOP_BEADS_NOT_STARTED")
    if os.execve in os.supports_fd:
        return executable
    # macOS execve takes a pathname. Recheck it at the launch boundary.
    if file_stamp(os.stat(path, follow_symlinks=False)) != expected:
        sys.exit("LOOP_BEADS_NOT_STARTED")
    return path


def read(args, operation, environment, descriptors):
    result = subprocess.run(
        args[:3] + ["--readonly"] + operation,
        env=environment,
        check=True,
        stdout=subprocess.PIPE,
        pass_fds=descriptors,
        timeout=20,
    )
    return json.loads(result.stdout)


def work_fence(identifier):
    return os.path.join(".loop-work-fences", str(uuid.UUID(identifier)))


def fence_attempt(identifier):
    # Any delayed launcher with this attempt ID will stop before the write.
    path = work_fence(identifier)
    parent = os.path.dirname(path)
    os.makedirs(parent, mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    for directory in (parent, "."):
        entry = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(entry)
        finally:
            os.close(entry)


def settle(expected, query):
    [bead] = query(["show", expected["bead"]])
    if bead["id"] != expected["bead"]:
        raise ValueError("unexpected bead")
    assignee = bead.get("assignee") or None
    current_claim = assignee == "loop-start-" + expected["generation"] and bead["status"] == "in_progress"
    release = expected.get("release")
    if release:
        metadata = bead.get("metadata") or {}
        if metadata.get("loop_release") == release:
            return "released"
        fence_attempt(release)
        return "unsent" if current_claim else "released"
    if current_claim:
        return "claimed"
    fence_attempt(expected["generation"])
    return "unsent" if bead["status"] == "open" and assignee is None else "refused"


def write_recorded(expected, query):
    operation = expected["operation"]
    bead_id = expected["bead"]
    marker = expected["marker"]
    if operation == "create":
        return any(item["id"] == bead_id for item in query(["list", "--all", "--id", bead_id]))
    if operation == "comment":
        suffix = "\n\n<!-- loop-comment:" + marker + " -->"
        matches = sum(item["text"].endswith(suffix) for item in query(["comments", bead_id]))
        if matches > 1:
            raise ValueError("ambiguous comment receipt")
        return matches == 1
    [bead] = query(["show", bead_id])
    if bead["id"] != bead_id:
        raise ValueError("unexpected bead")
    if operation == "close":
        suffix = "\n\n<!-- loop-close:" + marker + " -->"
        return bead["status"] == "closed" and (bead.get("close_reason") or "").endswith(suffix)
    if operation == "dependency":
        return any(
            (item.get("depends_on_id") or item.get("id")) == expected["blocker"]
            for item in bead.get("dependencies") or []
        )
    raise ValueError("unsupported write operation")


def require_unfenced(identifier):
    if os.path.exists(work_fence(identifier)):
        sys.exit("LOOP_BEADS_FENCED")


def run():
    fd = acquire()
    args = sys.argv[1:]
    if args[0] == "--install":
        publish(*args[1:])
        return
    stamp = executable = None
    if args[0] == "--verify":
        stamp, args = args[1], args[2:]
    guard = {"--current", "--settle-write", "--settle", "--ready", "--release", "--attempt"}
    operation = value = None
    if args[0] in guard:
        operation, value, args = args[0], args[1], args[2:]
    if stamp is not None:
        executable = open_verified(args[0], stamp)
    directory = os.getcwd()
    environment = {
        "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
        "HOME": directory,
        "BEADS_DIR": os.path.join(directory, ".beads"),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CEILING_DIRECTORIES": os.path.dirname(directory),
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "core.hooksPath",
        "GIT_CONFIG_VALUE_0": "/dev/null",
        "CI": "true",
    }

    def query(command):
        target = executable_target(args[0], stamp, executable)
        if isinstance(target, int):
            return read(["/proc/self/fd/" + str(target)] + args[1:], command, environment, (fd, target))
        return read(args, command, environment, (fd,))

    if operation == "--current":
        expected = json.loads(value)
        require_unfenced(expected.pop("marker"))
        [bead] = query(["show", expected["id"]])
        actual = {
            "id": bead["id"],
            "status": bead["status"],
            "assignee": bead.get("assignee") or None,
            "release": (bead.get("metadata") or {}).get("loop_release"),
        }
        if actual != expected:
            sys.exit(13)
    elif operation == "--settle-write":
        expected = json.loads(value)
        recorded = write_recorded(expected, query)
        if not recorded or expected["operation"] == "dependency":
            fence_attempt(expected["marker"])
        print(json.dumps("committed" if recorded else "refused"))
        return
    elif operation == "--settle":
        print(json.dumps(settle(json.loads(value), query)))
        return
    elif operation == "--ready":
        expected = json.loads(value)
        require_unfenced(expected["generation"])
        ready = query(["ready", "--limit", "0", "--max-rows", "50000"])
        if not any(issue["id"] == expected["bead"] for issue in ready):
            sys.exit(13)
    elif operation in ("--release", "--attempt"):
        require_unfenced(value)

    os.set_inheritable(fd, True)
    os.execve(executable_target(args[0], stamp, executable), args, environment)


if __name__ == "__main__":
    try:
        run()
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, KeyError):
        sys.exit("LOOP_BEADS_NOT_STARTED")
