# G2: local software-VM inert preflight

**State: INERT_TCG_FEASIBLE_ONLY. G2 and G8 are NOT_VERIFIED.** This is an optional lab procedure, not an executor, an admission authority, or a workaround for a denied host sandbox. The historical bubblewrap denial was not retried. No Agent Forge policy, runner capability, host security setting, or production gate is changed. Do not substitute the inert result for real-agent isolation.

## What was observed on one Linux cloud host

QEMU 10.0.13 (Debian 1:10.0.13+ds-0+deb13u1) ran with CPU emulation (TCG), not KVM. The guest kernel was Debian 6.12.117+deb13-cloud-amd64. Tools were extracted from the official Debian trixie package set into a scoped directory after using APT's signed package index and checking package digests; nothing was system-installed. No external VM service, real adapter, account, credential access, model call, or untrusted candidate code was involved.

The VM had explicit QEMU seccomp policy with all four deny settings, no default devices or user config, no NIC, USB, monitor, host directory sharing, passthrough device, Agent Forge workspace, or user files. It used at most one vCPU and 192 MiB of configured guest RAM. QEMU received only a minimal process environment and closed stdin. Each invocation was time-bounded. A read-only raw floppy contained a self-authored 512-byte BIOS marker; the separate Linux run had no block drive and booted the stock kernel and temporary RAM filesystem with one static diagnostic program.

| Case | Exact outcome |
|---|---|
| Read-only BIOS marker | Expected marker line and guest exit 85. |
| Linux positive | Private guest RAM write succeeded; the real, self-authored host-only canary path was absent from the guest; only loopback was present; a UDP socket route lookup to a documentation address returned ENETUNREACH without sending a packet. Expected exact marker and exit 85. |
| Linux deliberate refusal | Exact refusal line, exit 87; no success marker. Tests the fixture/supervisor interpretation, **not** an isolation violation. |
| Paused guest watchdog | Host timeout 124, PID file removed, no guest output. |
| Host inputs | Host canary, stock executable/firmware/kernel, read-only media and initramfs compared unchanged after the run. |

The observed properties apply only to these fixed fixtures. No broad escape/attack resistance, hostile I/O, arbitrary CPU/memory/disk quotas, device isolation on other hosts, multi-tenant pooling, or cleanup under host crash was assessed. Network-route absence is not active egress verification. Checking the canary does not prove universal host filesystem exclusion.

## Reproduce without changing the host security profile

Use an eligible Debian trixie x86-64 host, GNU coreutils, GCC with static libc development files, GNU binutils and Python 3. Prepare a **clean**, user-owned SDK extraction directory on the same machine using trusted stock Debian packages. The expected packages, exact pool paths and SHA-256 digests are listed in [the fixture's package lock](../fixtures/forge-tcg-inert/debian-trixie-amd64.sha256). Require authentic signed Debian index metadata as well as exact hashes; do not install any package globally. `dpkg-deb -x` into that clean directory is sufficient on a host with the remaining compatible shared libraries. Different hosts may lack compatible host dependencies; treat that as unverified. The harness also pins QEMU, firmware and kernel artifacts. Missing packages or a host denial are stop conditions: do not turn off seccomp, switch permissions, or remove another control to run this fixture.

In a clean checkout:

```sh
FORGE_TCG_SDK=/absolute/path/to/verified-extracted-debian-sdk sh fixtures/forge-tcg-inert/run.sh
```

The script can run only its authored marker, Linux diagnostic and fixed-input fixture; it takes no guest files or commands as input and is not part of Agent Forge's product or automatic test commands. No binaries are distributed in this repository.

## Host budget and cleanup calibration

The same opt-in QEMU command now inherits fixed Linux process limits via
`prlimit`: soft/hard CPU seconds 30/31, 64 KiB per regular file, 128 open file
descriptors, and zero core bytes. The existing guest RAM/vCPU bounds, wall
deadlines and seccomp configuration remain in place. Missing or rejected limit
tooling fails the run; there is no unrestricted fallback.

For a fixed host-only calibration without QEMU or its SDK:

```sh
sh fixtures/forge-tcg-inert/probe-resources.sh
```

The fixture checks exact inherited limits; it tests that the kernel refuses one
extra byte with EFBIG and one extra file descriptor with EMFILE. CPU and core
limits are read back, not triggered. A separate fixed process-group case waits
for its forked child, then the GNU timeout sends SIGTERM to the isolated group.
The parent receipt requires that the child actually died by SIGTERM and was
reaped, alongside the watchdog reporting exit 124. Separately, the actual QEMU
paused guest exits by timeout and releases its PID file. These are controlled
exact-output checks, not permission to run another program.

These are process-local ceilings; file size is not aggregate disk capacity,
and guest RAM is not a host memory quota. The test does not establish a process
count quota, process-tree cleanup after arbitrary group/session changes, escape
resistance, or guaranteed teardown on host crash. No enforced cgroup or
multi-tenant isolation is implied. The fixture remains offline and does not
attempt to run or admit an agent.

## Fixed-input VM run and independent host acceptance

The same opt-in command now stages one authored 59-byte JSON input as a
mode-0444 entry in the guest initramfs. The guest opens it read-only and
changes only byte 56 (zero-based), ASCII `1` to `0`. The guest has no
expected-output copy, host filesystem share, network interface, or command from
the caller. A dedicated debug stream carries the raw bytes out; the host
captures it in an exclusively created file in the private run directory.

| Case | Host requires |
|---|---|
| Fixed input | Guest exit 85, no stderr, exact 59 bytes, and SHA-256 `beb0c4159ca575aaba351ffaf25d242a440d786ac83aace939f54263acc40af2` against the independently authored host oracle. |
| Wrong output | Same exit 85 and byte length, but byte 56 is ASCII `2`; the same host verifier must reject it. |
| Paused VM | Watchdog exit 124, no guest output, and just the QEMU SIGTERM diagnostic on stderr; the same host verifier must reject it. |

For all three cases the host checks the exact case-directory inventory after the
watchdog returns (no leftover QEMU PID file), and recomputes the digests of the
original input, initramfs and other pinned run inputs. The harness prints
`FIXED_INPUT_HOST_VERIFIED` only after also removing its private run directory
and verifying the path is gone. QEMU runs in the foreground under the
bounded watchdog; this does not establish teardown on host crash or cleanup
of arbitrary escaped processes. The result is one inert task, not a provider
run, a production executor, or a change to G2 or G8.

## Before considering real execution

Review a separately scoped launcher with immutable tool/input bindings, independent containment evidence, strict sanitized staging/export, per-run resource budgets, constrained outputs and reliable cleanup. Any real executor or model use needs separate explicit provider/account/model/budget authorization and actual target evidence. Existing two-heterogeneous-adapter and real-task gate requirements remain unchanged. No hosted run, CI dispatch, merge, or external environment transfer is implied by this preflight.
