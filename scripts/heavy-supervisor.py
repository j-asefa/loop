"""Foreground Linux descendant cleanup; commands start without admission.

PR_SET_CHILD_SUBREAPER makes orphaned browser/fixture processes our children.
The cgroup remains the enforcement boundary, including a kill of this supervisor.
"""
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

GRACE = 5


def descendants():
    found = set()
    complete = True
    missing_children = False
    pending = [os.getpid()]
    while pending:
        pid = pending.pop()
        try:
            tasks = list(Path(f"/proc/{pid}/task").glob("*/children"))
            missing_children = missing_children or not tasks
            for task in tasks:
                try:
                    children = [int(value) for value in task.read_text().split()]
                except (FileNotFoundError, ProcessLookupError):
                    complete = False
                    continue
                for child in children:
                    if child not in found:
                        found.add(child)
                        pending.append(child)
        except (FileNotFoundError, ProcessLookupError):
            # A PID may exit between collecting it and iterating its tasks.
            # Reaping and the next scan still find any adopted descendants.
            complete = False
    if missing_children:
        # Some Linux kernels omit /proc/PID/task/TID/children. PPid remains
        # available; never interpret the missing optional interface as no work.
        parents = {}
        for name in os.listdir("/proc"):
            if not name.isdigit():
                continue
            try:
                with open(f"/proc/{name}/stat") as stream:
                    fields = stream.read().rsplit(")", 1)[1].split()
                parents.setdefault(int(fields[1]), []).append(int(name))
            except (FileNotFoundError, ProcessLookupError):
                continue
        pending, seen = [os.getpid()], set()
        while pending:
            for child in parents.get(pending.pop(), []):
                if child not in seen:
                    seen.add(child)
                    found.add(child)
                    pending.append(child)
    return found, complete


def send(pid, sig):
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        pass


def main():
    config = json.loads(sys.argv[1])
    label = config["label"]
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

    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        report("not started; could not supervise orphaned children")
        return 127
    if interrupted():
        return 128 + interrupted()
    try:
        child = subprocess.Popen(sys.argv[2:])
    except OSError as error:
        report(f"not started: {error}")
        return 127
    result = None
    deadline = None
    notified = set()
    while True:
        no_children = False
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                pid = 0
                no_children = True
            if not pid:
                break
            if pid == child.pid:
                child.returncode = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -os.WTERMSIG(status)
                result = child.returncode if child.returncode >= 0 else 128 - child.returncode
        remaining, complete = descendants()
        if result is not None and no_children and not remaining and complete:
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
        print("Command supervision requires Python 3.8 or newer; command not started", file=sys.stderr)
        sys.exit(127)
    sys.exit(main())
