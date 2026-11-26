#!/bin/sh
# Fixed, opt-in QEMU smoke only. No arbitrary guest, command, provider, or mount input.
set -eu
umask 077
PATH=/usr/bin:/bin
export PATH
test "$#" -eq 0 || { echo 'unexpected argument' >&2; exit 2; }
case "${FORGE_TCG_SDK:-}" in
 /*) ;;
 *) echo 'FORGE_TCG_SDK must be an absolute path to the verified stock package extraction' >&2; exit 2 ;;
esac
S=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$S/resource-guard.sh"
SDK=$(CDPATH= cd -- "$FORGE_TCG_SDK" && pwd -P)
Q="$SDK/usr/bin/qemu-system-x86_64"
L="$SDK/usr/lib/x86_64-linux-gnu"
K="$SDK/boot/vmlinuz-6.12.117+deb13-cloud-amd64"
B="$SDK/usr/share/seabios/bios-256k.bin"
test -x "$Q"
printf '%s  %s\n' \
 d3c1a558ad220e77a4412048c8d96b44f8c2b41c7ad2a4ecfe522a4b122fe067 "$Q" \
 fc6d2ea888862e6b26d53fb877ab712324726eb8f44eb6baf076c64a31f1c3fb "$B" \
 ed8f0dbdbefe3994093937f5ee934818ae902b88cb0b6bc423811c10d55b87b0 "$K" | sha256sum --check --status

W=$(mktemp -d /tmp/forge-tcg-inert.XXXXXXXX)
trap 'rm -rf -- "$W"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$W"
# All caller-controlled compilation options are deliberately ignored.
env -i PATH=/usr/bin:/bin LC_ALL=C as --32 --fatal-warnings -o marker.o "$S/marker.s"
env -i PATH=/usr/bin:/bin LC_ALL=C ld -m elf_i386 -Ttext 0x7c00 --oformat binary -o marker.raw marker.o
test "$(wc -c < marker.raw)" -eq 512
cp marker.raw readonly.img
truncate -s 1474560 readonly.img
printf 'authored inert host-path canary\n' > host-only-canary
env -i PATH=/usr/bin:/bin LC_ALL=C cc -static -std=c11 -O2 -Wall -Wextra -Werror \
 "-DHOST_ONLY_CANARY=\"$W/host-only-canary\"" "$S/linux-inert.c" -o linux-inert
env -i PATH=/usr/bin:/bin LC_ALL=C python3 -I "$S/build-initramfs.py"
sha256sum "$K" "$B" "$Q" host-only-canary linux-initramfs.cpio.gz readonly.img > before.sha256

fixed_qemu() {
    duration=$1
    shift
    inert_limits timeout -k 2s "$duration" env -i PATH=/usr/bin:/bin LD_LIBRARY_PATH="$L" HOME="$W" LC_ALL=C "$Q" \
      -machine pc,accel=tcg,usb=off -smp 1 \
      -nodefaults -no-user-config -display none -serial none -parallel none -monitor none -nic none -no-reboot \
      -sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny \
      -L "$SDK/usr/share/qemu" -bios "$B" "$@" </dev/null
}
fixed_error_exit() {
    rc=$1 expected=$2 name=$3
    if [ "$rc" -ne "$expected" ]; then
        echo "$name: expected exit $expected, observed $rc" >&2
        cat "$name.stderr" >&2
        exit 1
    fi
}

rc=0
fixed_qemu 16s -m 64 -drive "file=$W/readonly.img,if=floppy,format=raw,readonly=on" -boot a \
  -debugcon stdio -device isa-debug-exit,iobase=0xf4,iosize=0x04 >marker.stdout 2>marker.stderr || rc=$?
fixed_error_exit "$rc" 85 marker
test ! -s marker.stderr
printf 'FORGE_TCG_INERT_BOOT_OK\n' >marker.expected
cmp -s marker.expected marker.stdout
printf 'marker: exact output and guest exit 85\n'

for mode in positive negative; do
    rc=0
    fixed_qemu 35s -m 192 -kernel "$K" -initrd "$W/linux-initramfs.cpio.gz" \
      -append "quiet panic=1 rdinit=/init forge.expect=$mode" \
      -debugcon stdio -device isa-debug-exit,iobase=0xf4,iosize=0x04 >"$mode.stdout" 2>"$mode.stderr" || rc=$?
    test ! -s "$mode.stderr"
    case "$mode" in
    positive)
        fixed_error_exit "$rc" 85 "$mode"
        printf '6.12.117+deb13-cloud-amd64\nFORGE_TCG_INERT_LINUX_OK\n' >"$mode.expected"
        ;;
    negative)
        fixed_error_exit "$rc" 87 "$mode"
        printf 'EXPECTED_NEGATIVE_FIXTURE\n' >"$mode.expected"
        ;;
    esac
    cmp -s "$mode.expected" "$mode.stdout"
    printf 'linux-%s: exact output and guest exit %s\n' "$mode" "$rc"
done

rc=0
fixed_qemu 2s -m 64 -S -pidfile "$W/paused.pid" >paused.stdout 2>paused.stderr || rc=$?
fixed_error_exit "$rc" 124 paused
test ! -s paused.stdout
test ! -e paused.pid
sha256sum --check --status before.sha256
printf 'paused: host timeout 124, PID file removed\n'

# Host owns the fixture input, output destinations, and independently written oracle.
# No expected result is put in the guest image and no shared host path is attached.
printf '%s\n' '{"fixture":"forge-tcg-fixed-offlinev1","networkEnabled":1}' >fixed-input
chmod 0444 fixed-input
env -i PATH=/usr/bin:/bin LC_ALL=C python3 -I "$S/build-initramfs.py" --fixed-input
sha256sum fixed-initramfs.cpio.gz >fixed-before.sha256
expected_sha=beb0c4159ca575aaba351ffaf25d242a440d786ac83aace939f54263acc40af2
printf '%s\n' '{"fixture":"forge-tcg-fixed-offlinev1","networkEnabled":0}' >fixed.expected
printf '%s  %s\n' "$expected_sha" fixed.expected | sha256sum --check --status

verify_fixed() {
    [ "$1" -eq 85 ] && [ ! -s "$2/stderr" ] &&
        [ "$(wc -c < "$2/output")" -eq 59 ] &&
        cmp -s fixed.expected "$2/output" &&
        printf '%s  %s\n' "$expected_sha" "$2/output" | sha256sum --check --status
}

for mode in fixed-input fixed-wrong fixed-timeout; do
    d="case-$mode"
    mkdir "$d"
    rc=0
    duration=35s
    set --
    if [ "$mode" = fixed-timeout ]; then duration=2s; set -- -S; fi
    (
        set -C
        fixed_qemu "$duration" -m 192 -kernel "$K" -initrd "$W/fixed-initramfs.cpio.gz" \
          -append "quiet panic=1 rdinit=/init forge.expect=$mode fixture.end=1" "$@" \
          -debugcon stdio -device isa-debug-exit,iobase=0xf4,iosize=0x04 \
          -pidfile "$W/$d/worker.pid" >"$d/output" 2>"$d/stderr"
    ) || rc=$?
    # timeout has waited for QEMU; verify no PID file or other exported entry remains.
    test "$(find "$d" -mindepth 1 -printf '%P:%y\n' | LC_ALL=C sort)" = "$(printf 'output:f\nstderr:f\n')"
    case "$mode" in
        fixed-input)
            verify_fixed "$rc" "$d" || { echo 'fixed input: host verification failed' >&2; exit 1; }
            ;;
        fixed-wrong)
            # Equal-size incorrect result and the same guest success status. Reject on bytes.
            test "$rc" -eq 85
            test ! -s "$d/stderr"
            test "$(wc -c < "$d/output")" -eq 59
            printf '%s\n' '{"fixture":"forge-tcg-fixed-offlinev1","networkEnabled":2}' | cmp -s - "$d/output"
            if verify_fixed "$rc" "$d"; then echo 'wrong bytes accepted' >&2; exit 1; fi
            ;;
        fixed-timeout)
            test "$rc" -eq 124
            test ! -s "$d/output"
            test "$(wc -l < "$d/stderr")" -eq 1
            grep -Exq 'qemu-system-x86_64: terminating on signal 15 from pid [1-9][0-9]* \(timeout\)' "$d/stderr"
            if verify_fixed "$rc" "$d"; then echo 'timeout accepted' >&2; exit 1; fi
            ;;
    esac
    printf '%s  %s\n' 0f5cf5c2c0b05117e94b8eb30ce0e3a38b06f5a720555afda201ac60009b3128 fixed-input |
        sha256sum --check --status
    sha256sum --check --status before.sha256 fixed-before.sha256
    printf '%s: host checked exit %s, output and process artifacts\n' "$mode" "$rc"
done
cd /
rm -rf -- "$W"
test ! -e "$W" && test ! -L "$W" || { echo 'fixture cleanup failed' >&2; exit 1; }
trap - EXIT
printf 'FIXED_INPUT_HOST_VERIFIED output_sha256=%s cleanup=verified\n' "$expected_sha"
printf 'INERT_TCG_FEASIBLE_ONLY G2=NOT_VERIFIED agent_execution=false\n'
