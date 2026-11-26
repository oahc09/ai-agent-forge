"""Fixed host calibration, separate from the guest and Agent Forge runtime."""

import errno
import os
import resource
import signal
import sys


def emit(message):
    os.write(1, message + b"\n")


def check(ok):
    if not ok:
        raise RuntimeError("inert calibration mismatch")


def caps():
    limits = {
        resource.RLIMIT_CPU: (30, 31),
        resource.RLIMIT_CORE: (0, 0),
        resource.RLIMIT_FSIZE: (65536, 65536),
        resource.RLIMIT_NOFILE: (128, 128),
    }
    for knob, expected in limits.items():
        check(resource.getrlimit(knob) == expected)
    emit(b"INERT_CPU_AND_CORE_LIMITS_READ_BACK")

    with open("inert.tmp", "xb", buffering=0) as capped:
        check(capped.write(bytes(65536)) == 65536)
        try:
            capped.write(b"x")
        except OSError as exc:
            check(exc.errno == errno.EFBIG)
        else:
            raise RuntimeError("file write limit did not stop one extra byte")
    check(os.stat("inert.tmp").st_size == 65536)
    fds = []
    try:
        for _ in range(128):
            try:
                fds.append(os.open(os.devnull, os.O_RDONLY))
            except OSError as exc:
                check(exc.errno == errno.EMFILE and len(fds) == 125)
                break
        else:
            raise RuntimeError("descriptor limit did not reject another open")
    finally:
        for fd in fds:
            os.close(fd)
    emit(b"INERT_FILE_AND_FD_LIMITS_ENFORCED")


def group():
    # The dedicated timeout group must not be the caller or this process.
    check(os.getpgrp() == os.getppid() and os.getpgrp() != os.getpid())
    ready_r, ready_w = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(ready_r)
        os.write(ready_w, b"r")
        os.close(ready_w)
        while True:
            signal.pause()

    def reap(_, __):
        # The timeout must have signalled the child directly, not via this parent.
        # Outer forced-kill deadline bounds this blocking wait if it did not.
        pid, status = os.waitpid(child, 0)
        if pid != child or not os.WIFSIGNALED(status) or os.WTERMSIG(status) != signal.SIGTERM:
            os._exit(1)
        emit(b"INERT_CHILD_TERM_REAPED")
        os._exit(0)

    signal.signal(signal.SIGTERM, reap)
    os.close(ready_w)
    check(os.read(ready_r, 1) == b"r")
    os.close(ready_r)
    emit(b"INERT_PROCESS_GROUP_READY")
    while True:
        signal.pause()


if sys.argv[1:] == ["caps"]:
    caps()
elif sys.argv[1:] == ["group"]:
    group()
else:
    sys.exit(2)
