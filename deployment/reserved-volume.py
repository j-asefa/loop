#!/usr/bin/env python3
"""Mount an already formatted, fully allocated Loop55 state image on Linux.

This never formats an image or copies application data. Provision and verify the
image separately. Discard is disabled on the loop device: trimming the inner
filesystem must not turn reserved blocks into holes in the backing file.
"""
import argparse
import json
import os
from pathlib import Path
import stat
import subprocess


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def configuration(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError("Volume configuration must be a root-owned regular file")
    data = json.loads(path.read_text())
    for key in ("image", "mountpoint"):
        p = Path(data[key])
        if not p.is_absolute() or p.resolve() != p:
            raise RuntimeError("Volume paths must be absolute and contain no symlinks")
    return data


def check_image(data):
    image = Path(data["image"])
    info = image.lstat()
    expected = data["bytes"]
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
            or info.st_nlink != 1 or info.st_mode & 0o077
            or info.st_size != expected or info.st_blocks * 512 < expected):
        raise RuntimeError("State image is not private, intact and fully allocated")
    return image


def mounted(data):
    try:
        result = json.loads(command("findmnt", "--json", "--mountpoint",
                                    data["mountpoint"], "--output", "SOURCE,UUID,FSTYPE"))
    except subprocess.CalledProcessError:
        return None
    rows = result.get("filesystems", [])
    if len(rows) != 1 or rows[0]["uuid"] != data["uuid"] or rows[0]["fstype"] != "ext4":
        raise RuntimeError("Unexpected filesystem at the Loop55 state mountpoint")
    source = rows[0]["source"]
    if not source.startswith("/dev/loop55"):
        raise RuntimeError("State filesystem is not on the configured loop device")
    backing = command("losetup", "--noheadings", "--output", "BACK-FILE", source)
    if backing != data["image"]:
        raise RuntimeError("State filesystem has the wrong backing file")
    return source


def discard_control(device):
    return Path("/sys/class/block") / Path(device).name / "queue/discard_max_bytes"


def ensure_mount(data):
    if os.geteuid() != 0:
        raise RuntimeError("Mounting reserved state requires root")
    image = check_image(data)
    device = mounted(data)
    if device is None:
        target = Path(data["mountpoint"])
        target.mkdir(parents=True, exist_ok=True)
        if any(target.iterdir()):
            raise RuntimeError("Refusing to hide existing files beneath the state mount")
        device = command("losetup", "--find", "--show", "--nooverlap", str(image))
        uuid = command("blkid", "-s", "UUID", "-o", "value", device)
        if uuid != data["uuid"]:
            raise RuntimeError("State image filesystem identity changed")
        discard_control(device).write_text("0\n")
        subprocess.run(["mount", "-t", "ext4", "-o", "noatime,nodiscard,nodev,nosuid",
                        device, str(target)], check=True)
    else:
        discard_control(device).write_text("0\n")
    verify(data)


def verify(data):
    check_image(data)
    device = mounted(data)
    if device is None or discard_control(device).read_text().strip() != "0":
        raise RuntimeError("Reserved Loop55 state is unavailable or permits discard")
    print(json.dumps({"state": "ready", "reserved_bytes": data["bytes"],
                      "mountpoint": data["mountpoint"], "discard_disabled": True}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["mount", "verify"])
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args()
    data = configuration(args.config)
    (ensure_mount if args.action == "mount" else verify)(data)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit("Loop55 state volume: " + str(error))
