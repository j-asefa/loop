"""Hold a per-store kernel lock across exec into the embedded Dolt process."""
import fcntl
import hashlib
import os
import stat
import sys
import tempfile
import time


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
        if not os.stat(destination).st_mode & 0o100:
            os.chmod(destination, 0o700)
    elif source:
        if os.path.isdir(destination) and not os.path.islink(destination):
            # Preserve unexpected directory contents. A file cannot replace a
            # directory, so move it aside under the same publication lock.
            rejected = tempfile.mkdtemp(prefix=".rejected-bd-", dir=os.path.dirname(destination))
            os.rename(destination, os.path.join(rejected, "bd"))
        os.replace(source, destination)
    else:
        sys.exit("LOOP_BEADS_NOT_STARTED")


def run():
    fd = acquire()
    if sys.argv[1] == "--install":
        publish(*sys.argv[2:])
        return
    os.set_inheritable(fd, True)
    os.execve(sys.argv[1], sys.argv[1:], {
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
    except OSError:
        sys.exit("LOOP_BEADS_NOT_STARTED")
