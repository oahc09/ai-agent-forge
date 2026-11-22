import gzip
from pathlib import Path
from stat import S_IFDIR, S_IFREG

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
add("TRAILER!!!", 0, 5)
Path("linux-initramfs.cpio.gz").write_bytes(gzip.compress(newc, mtime=0))
