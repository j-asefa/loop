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
                sys.exit("Timed out waiting for the project Work store")
            time.sleep(0.05)
        else:
            break

    os.set_inheritable(fd, True)
    os.execv(sys.argv[1], sys.argv[1:])


if __name__ == "__main__":
    run()
