"""Foreground Linux admission and descendant cleanup; no daemon or new session.

PR_SET_CHILD_SUBREAPER makes orphaned browser/fixture processes our children.
Keep the flock until all of them are reaped, even if the JS caller is killed.
The cgroup remains the enforcement boundary, including a kill of this supervisor.
"""
import ctypes
import fcntl
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time

BUSY = 75
GRACE = 5


def process_info(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return int(fields[1]), fields[19]
    except (OSError, ValueError, IndexError):
        return None


def nested_slot(lock):
    try:
        marker = json.loads(os.environ.get("LOOP_HEAVY_SLOT", "null"))
        if not marker or marker[2] != lock:
            return False
        pid = os.getppid()
        while pid > 1:
            info = process_info(pid)
            if not info:
                break
            if pid == marker[0] and info[1] == marker[1]:
                return True
            pid = info[0]
    except (ValueError, TypeError, IndexError, KeyError):
        pass
    return False


def is_within(path, root):
    return path == root or root in path.parents


def memory_headroom(proc=Path("/proc"), root=Path("/sys/fs/cgroup")):
    """Inspect every visible ancestor ceiling, plus host available memory."""
    available = []
    for line in (proc / "meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            available.append(int(line.split()[1]) * 1024)
    for line in (proc / "self/cgroup").read_text().splitlines():
        if not line.startswith("0::"):
            continue
        directory = (root / line[3:].lstrip("/")).resolve()
        # A namespaced mount can expose only the container root.
        if not is_within(directory, root) or not directory.exists():
            directory = root
        while is_within(directory, root):
            try:
                limit = (directory / "memory.max").read_text().strip()
                if limit != "max":
                    current = int((directory / "memory.current").read_text())
                    stats = dict(line.split() for line in (directory / "memory.stat").read_text().splitlines())
                    # Inactive filesystem cache can be reclaimed. Counting it
                    # as a live allocation can block an idle, warm checkout.
                    reclaimable = max(0, int(stats.get("inactive_file", 0)) - int(stats.get("file_dirty", 0)) - int(stats.get("file_writeback", 0)))
                    available.append(int(limit) - max(0, current - reclaimable))
            except FileNotFoundError:
                pass
            directory = directory.parent
    return min(available) if available else float("inf")


def descendants():
    found = set()
    pending = [os.getpid()]
    while pending:
        pid = pending.pop()
        for task in Path(f"/proc/{pid}/task").glob("*/children"):
            try:
                children = [int(value) for value in task.read_text().split()]
            except FileNotFoundError:
                continue
            for child in children:
                if child not in found:
                    found.add(child)
                    pending.append(child)
    return found


def send(pid, sig):
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        pass


def main():
    config = json.loads(sys.argv[1])
    label = config["label"]
    lock = os.path.join(os.path.realpath(os.path.dirname(config["lock"])), os.path.basename(config["lock"]))
    parent = config["parentPid"]
    cancelled = 0

    def report(message):
        try:
            os.write(3, f"{label}: {message}\n".encode())
        except (BrokenPipeError, OSError):
            pass  # Caller may have been killed; cleanup must continue.

    def cancel(sig, _frame):
        nonlocal cancelled
        cancelled = cancelled or sig

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, cancel)

    def interrupted():
        return cancelled or (signal.SIGTERM if os.getppid() != parent else 0)

    # Nested builds/tests use the outer reservation without another lock. Each
    # supervisor still owns cleanup of its subtree. No unverified env bypass.
    nested = nested_slot(lock)
    fd = None
    if not nested:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                raise PermissionError("lock is not a regular file owned by this user")
            started = time.monotonic()
            reported = False
            while True:
                if interrupted():
                    return 128 + interrupted()
                held = False
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    held = True
                except BlockingIOError:
                    pass
                enough = held and (config["reserveMiB"] == 0 or memory_headroom() >= config["reserveMiB"] * 1024 * 1024)
                if enough:
                    break
                if held:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                elapsed = time.monotonic() - started
                if elapsed >= config["waitSeconds"]:
                    report("not started; heavy-check slot or memory headroom unavailable; retry later")
                    return BUSY
                if elapsed >= 1 and not reported:
                    report(f"waiting for the host's heavy-check slot and {config['reserveMiB']:g} MiB estimated headroom (up to {config['waitSeconds']:g}s)")
                    reported = True
                time.sleep(min(0.1, config["waitSeconds"] - elapsed))
            if reported:
                report(f"slot acquired after {time.monotonic() - started:.1f}s")
        except OSError as error:
            report(f"not started; admission failed: {error}")
            return BUSY

    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        report("not started; could not supervise orphaned children")
        return BUSY
    if interrupted():
        return 128 + interrupted()
    env = dict(os.environ)
    if not nested:
        env["LOOP_HEAVY_SLOT"] = json.dumps([os.getpid(), process_info(os.getpid())[1], lock])
    try:
        child = subprocess.Popen(sys.argv[2:], env=env)
    except OSError as error:
        report(f"not started: {error}")
        return 127
    result = None
    deadline = None
    notified = set()
    while True:
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                pid = 0
            if not pid:
                break
            if pid == child.pid:
                child.returncode = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -os.WTERMSIG(status)
                result = child.returncode if child.returncode >= 0 else 128 - child.returncode
        remaining = descendants()
        if result is not None and not remaining:
            return 128 + interrupted() if interrupted() else result
        if interrupted() or result is not None:
            if deadline is None:
                deadline = time.monotonic() + GRACE
            # Give the command its graceful cleanup window first. Once it
            # exits, adopted descendants receive TERM, then bounded escalation.
            targets = remaining if result is not None else {child.pid}
            if time.monotonic() >= deadline:
                for pid in remaining:
                    send(pid, signal.SIGKILL)
            else:
                for pid in targets - notified:
                    send(pid, signal.SIGTERM)
                    notified.add(pid)
        time.sleep(0.05)


if __name__ == "__main__":
    if sys.version_info < (3, 8):
        print("Heavy-check admission requires Python 3.8 or newer; command not started", file=sys.stderr)
        sys.exit(127)
    sys.exit(main())
