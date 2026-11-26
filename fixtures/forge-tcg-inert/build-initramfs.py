import gzip
from pathlib import Path
from stat import S_IFDIR, S_IFREG
import sys

newc = bytearray()
def add(name, mode, ino, payload=b""):
    name = name.encode() + b"\0"
    fields = (ino, mode, 0, 0, 1, 0, len(payload), 0, 0, 0, 0, len(name), 0)
    newc.extend(b"070701" + "".join(f"{f:08x}" for f in fields).encode() + name)
    newc.extend(b"\0" * (-len(newc) % 4))
    newc.extend(payload)
    newc.extend(b"\0" * (-len(newc) % 4))
for index, name in enumerate(("proc", "sys", "dev"), 1):
    add(name, S_IFDIR | 0o755, index)
add("init", S_IFREG | 0o755, 4, Path("linux-inert").read_bytes())
if sys.argv[1:] == ["--fixed-input"]:
    add("fixed-input", S_IFREG | 0o444, 5, Path("fixed-input").read_bytes())
    output = "fixed-initramfs.cpio.gz"
elif not sys.argv[1:]:
    output = "linux-initramfs.cpio.gz"
else:
    raise SystemExit("unexpected argument")
add("TRAILER!!!", 0, 6)
Path(output).write_bytes(gzip.compress(newc, mtime=0))
