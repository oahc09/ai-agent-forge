# M2 real-execution blockers — 2026-11-08

G1 passed on b20c53d7dc0e8fbe342e0ecb7860d9cd22c7db81: independent review,
clean exact-commit verification (372 tests,45 security) and both GitHub CI runs.
M2-01/05 offline SDK/Context work can continue. The following are not verified:

## M2-02 / M2-03: two real heterogeneous executors

Codex CLI 0.167.0-alpha.4 is installed. Its presence is not proof of configured,
authorized provider access, cost accounting or successful real execution. OpenCode/Pi
were not found on PATH. No real provider invocation or credential inspection occurred.
Before real E2E: operator must choose/authorize two executors/providers, their account
access, model versions and per-task/daily/total monetary budgets. Current provider
budget remains zero and product policy allows only offline fixtures.

## M2-04: operating-system sandbox

bubblewrap 0.12.0 is installed. A minimal no-network, read-only true-command probe:

```sh
bwrap --unshare-user --unshare-pid --unshare-net --die-with-parent \
  --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 -- /usr/bin/true
```

Actual exit code: 1.
Actual stderr: `bwrap: loopback: Failed to create NETLINK_ROUTE socket: Operation not permitted`.

No privilege escalation, security-setting change, alternate bypass or environment transfer
was attempted. M1's same-UID credential-free fixture is not an adequate replacement for
M2 sandbox acceptance. A permitted runtime with real filesystem/process/network resource
isolation is needed before executing untrusted coding agents. Any transfer to another
execution environment requires the user's separate approval.

## Gate consequence

G2 is blocked, and M3–M7 remain dependency-blocked. G8 remains NOT_VERIFIED; no
72-hour soak,30-day campaign,paid model trial or remote autonomous development has started.
Neither an SDK contract nor generated Fake output can satisfy the two real adapter or
sandbox tests. Do not substitute a mocked sandbox or duplicate adapter shell to pass G2.

## User-selected current-environment alternative

The user subsequently requested native subagents in the current environment. A bounded
real coding task and separate read-only review were completed in that mode; see
[native-agent qualification](native-subagent-qualification.md). Native roles are usable
for development assistance but do not supply a standalone daemon transport, heterogeneous
executor evidence, or the denied OS isolation. Original G2 remains NOT_PASSED; no new
provider expense, environment transfer or acceptance-threshold change is inferred.
