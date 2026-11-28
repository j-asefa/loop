"""Hold a per-store kernel lock across exec into the embedded Dolt process."""
import fcntl
import hashlib
import os
import sys
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
