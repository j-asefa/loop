"""Hold a per-store kernel lock across exec into the embedded Dolt process."""
import fcntl
import hashlib
import json
import subprocess
import os
import sys
import time
import uuid


def acquire():
    fd = os.open(".loop-beads.lock", os.O_CREAT | os.O_RDWR, 0o600)
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
        with open(destination, "rb") as binary:
            for chunk in iter(lambda: binary.read(1024 * 1024), b""):
                digest.update(chunk)
            return digest.hexdigest() == expected
    except FileNotFoundError:
        return False


def publish(source, destination, expected):
    # All Loop installers use this directory's lock before changing the
    # published inode or its mode. Downloads stage outside the critical section.
    if installed(destination, expected):
        if not os.stat(destination).st_mode & 0o100:
            os.chmod(destination, 0o700)
    elif source:
        os.replace(source, destination)
    else:
        sys.exit("LOOP_BEADS_NOT_STARTED")


def read(args, operation, environment, fd):
    result = subprocess.run(
        args[:3] + ["--readonly"] + operation,
        env=environment,
        check=True,
        stdout=subprocess.PIPE,
        pass_fds=(fd,),
        timeout=20,
    )
    return json.loads(result.stdout)


def claim_fence(identifier):
    return os.path.join(".loop-claim-fences", str(uuid.UUID(identifier)))


def settle_claim(args, expected, environment, fd):
    [bead] = read(args, ["show", expected["bead"]], environment, fd)
    if bead["id"] != expected["bead"]:
        raise ValueError("unexpected bead")
    assignee = bead.get("assignee") or None
    generation = expected["generation"]
    if assignee == "loop-start-" + generation and bead["status"] == "in_progress":
        return "claimed"

    # A delayed launch with this generation must lose after this locked read.
    # A later explicit resume uses a fresh generation of the same request.
    path = claim_fence(generation)
    parent = os.path.dirname(path)
    os.makedirs(parent, mode=0o700, exist_ok=True)
    fence = os.open(path, os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.fsync(fence)
    finally:
        os.close(fence)
    for directory in (parent, "."):
        entry = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(entry)
        finally:
            os.close(entry)
    return "unsent" if bead["status"] == "open" and assignee is None else "refused"


def run():
    fd = acquire()
    if sys.argv[1] == "--install":
        publish(*sys.argv[2:])
        return
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
    args = sys.argv[1:]
    if args[0] == "--current":
        expected = json.loads(args[1])
        args = args[2:]
        [bead] = read(args, ["show", expected["id"]], environment, fd)
        actual = {
            "id": bead["id"],
            "status": bead["status"],
            "assignee": bead.get("assignee") or None,
        }
        if actual != expected:
            sys.exit(13)
    elif args[0] == "--settle-claim":
        expected = json.loads(args[1])
        print(json.dumps(settle_claim(args[2:], expected, environment, fd)))
        return
    elif args[0] == "--ready":
        expected = json.loads(args[1])
        args = args[2:]
        if os.path.exists(claim_fence(expected["generation"])):
            sys.exit("LOOP_BEADS_FENCED_CLAIM")
        ready = read(args, ["ready", "--limit", "0", "--max-rows", "50000"], environment, fd)
        if not any(issue["id"] == expected["bead"] for issue in ready):
            sys.exit(13)
    os.set_inheritable(fd, True)
    os.execve(args[0], args, environment)


if __name__ == "__main__":
    try:
        run()
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, KeyError):
        sys.exit("LOOP_BEADS_NOT_STARTED")
