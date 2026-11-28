"""Hold a per-store kernel lock across exec into the embedded Dolt process."""
import fcntl
import os
import sys
import time


def run():
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

    os.set_inheritable(fd, True)
    try:
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
    except OSError:
        sys.exit("LOOP_BEADS_NOT_STARTED")


if __name__ == "__main__":
    run()
