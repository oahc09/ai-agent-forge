#!/bin/sh
# Only the authored calibration cases are executable via this entrypoint.
set -eu
umask 077
test "$#" -eq 0 || { echo 'unexpected argument' >&2; exit 2; }
PATH=/usr/bin:/bin
export PATH
S=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$S/resource-guard.sh"
W=$(mktemp -d /tmp/forge-tcg-calibration.XXXXXXXX)
trap 'rm -rf -- "$W"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$W"
inert_limits env -i PATH=/usr/bin:/bin HOME="$W" LC_ALL=C python3 -I "$S/resource-probe.py" caps >caps.stdout
printf 'INERT_CPU_AND_CORE_LIMITS_READ_BACK\nINERT_FILE_AND_FD_LIMITS_ENFORCED\n' >caps.expected
cmp -s caps.expected caps.stdout
cat caps.stdout

rc=0
inert_limits timeout -s TERM -k 2s 3s env -i PATH=/usr/bin:/bin HOME="$W" LC_ALL=C \
  python3 -I "$S/resource-probe.py" group >group.stdout 2>group.stderr || rc=$?
test "$rc" -eq 124 && test ! -s group.stderr
printf 'INERT_PROCESS_GROUP_READY\nINERT_CHILD_TERM_REAPED\n' >group.expected
cmp -s group.expected group.stdout
cat group.stdout
printf 'INERT_CALIBRATION_ONLY G2=NOT_VERIFIED agent_execution=false\n'
