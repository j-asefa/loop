"""Hold a per-store kernel lock across exec into the embedded Dolt process."""
import fcntl
import hashlib
import os
import stat
import sys
import time


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


def run():
    fd = acquire()
    args = sys.argv[1:]
    if args[0] == "--install":
        publish(*args[1:])
        return
    expected = executable = None
    if args[0] == "--verify":
        expected = args[1]
        args = args[2:]
        executable = open_verified(args[0], expected)
    os.set_inheritable(fd, True)
    os.execve(executable_target(args[0], expected, executable), args, {
            "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
            "HOME": os.getcwd(),
            "BEADS_DIR": os.path.join(os.getcwd(), ".beads"),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CEILING_DIRECTORIES": os.path.dirname(os.getcwd()),
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "core.hooksPath",
            "GIT_CONFIG_VALUE_0": "/dev/null",
            "CI": "true",
    })


if __name__ == "__main__":
    try:
        run()
    except (OSError, IndexError):
        sys.exit("LOOP_BEADS_NOT_STARTED")
