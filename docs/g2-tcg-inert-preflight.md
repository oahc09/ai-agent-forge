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

The script can run only its authored marker and Linux diagnostic; it takes no guest files or commands as input and is not part of Agent Forge's product or automatic test commands. No binaries are distributed in this repository.

## Before considering real execution

Review a separately scoped launcher with immutable tool/input bindings, independent containment evidence, strict sanitized staging/export, per-run resource budgets, constrained outputs and reliable cleanup. Any real executor or model use needs separate explicit provider/account/model/budget authorization and actual target evidence. Existing two-heterogeneous-adapter and real-task gate requirements remain unchanged. No hosted run, CI dispatch, merge, or external environment transfer is implied by this preflight.
