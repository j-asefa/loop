#!/usr/bin/env python3
"""Exec a native harness inside the host's aggregate systemd resource budget.

Linux, cgroup v2 and a systemd user manager are required. No command is executed
if placement fails. Unlike systemd-run's service transport, exec preserves the
native protocol's extra file descriptors, PID, environment and process group.
"""
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid


def main():
    if len(sys.argv) < 2 or not Path('/sys/fs/cgroup/cgroup.controllers').exists():
        raise RuntimeError('A command and Linux cgroup v2 are required')
    unit = f'loop55-agent-{os.getpid()}-{uuid.uuid4().hex}.scope'
    subprocess.run([
        'busctl', '--user', '--timeout=10s', 'call',
        'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
        'org.freedesktop.systemd1.Manager', 'StartTransientUnit',
        'ssa(sv)a(sa(sv))', unit, 'fail', '3',
        'Slice', 's', 'loop55-agents.slice',
        'PIDs', 'au', '1', str(os.getpid()),
        'CollectMode', 's', 'inactive-or-failed', '0',
    ], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, timeout=12)
    deadline = time.monotonic() + 5
    while True:
        groups = Path('/proc/self/cgroup').read_text().splitlines()
        group = next((line[3:] for line in groups if line.startswith('0::')
                      and line.endswith('/' + unit)
                      and '/loop55-agents.slice/' in line), None)
        if group:
            budget = Path('/sys/fs/cgroup') / group.lstrip('/')
            budget = budget.parent / 'memory.max'
            if not budget.read_text().strip().isdigit():
                raise RuntimeError('The agent slice has no memory ceiling')
            break
        if time.monotonic() >= deadline:
            raise RuntimeError('The resource scope did not accept the process')
        time.sleep(0.01)
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError):
        # Arguments/environment can contain native credentials. Do not print
        # either, or fall back to an unconstrained launch.
        print('Loop55 could not place the native process in its resource budget.', file=sys.stderr)
        sys.exit(126)
