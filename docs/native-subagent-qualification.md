# Current-environment native-agent qualification

## Authorized operating mode

On 2026-11-08 the user requested: “当前环境使用 子 agent替代”.
This permits using native coding and review roles in the existing environment.
It does not approve a different environment, a new paid provider account or spending
limit, privilege escalation, or claiming that native roles provide OS sandbox isolation.

## Controlled demonstration

A native coding role was assigned one bounded, low-risk repository task: add a regression
test for the four execution JSON-schema entrypoints and matching runtime fixtures.
A separate read-only native review role checks the change and executes verification.
No production permission/execution code is changed by this task. The fixed offline
runtime and zero-provider budget remain unchanged. Exact outcome is recorded below.

This demonstrates host-orchestrated coding and independent review. It is not a run
started by the standalone Forge daemon and is not the AF-BOOTSTRAP-001 autonomy proof.
The human-facing host performs assignment and handoff; the daemon currently supports
only its fixed Fake worker and the SDK's offline FakeAdapter.

## Qualification against the original v1.1 plan

| Requirement | Qualification |
|---|---|
| Use native coding/review roles in current environment | Supported for bounded development work |
| M2-02: real AgentAdapter lifecycle/version/cost/cancellation evidence | NOT_VERIFIED: no standalone native transport implemented |
| M2-03: two heterogeneous executors over the same ten real tasks | NOT_VERIFIED: two roles on one native execution mechanism are not two harnesses |
| M2-04: filesystem/process/network/resource isolation | BLOCKED: previous bubblewrap EPERM remains; native roles do not change it |
| Native service per-run model/cost metadata | NOT_VERIFIED: this demonstration does not supply verified provider billing metadata |
| External paid CLI/provider invocation | None performed for this demonstration |
| G2 | NOT_PASSED under the original plan |
| M3–M7 / G8 | No dependency unlock or acceptance claim |

The source of truth is the original plan. No benchmark, security threshold or past
result is altered to make a replacement pass. No denied isolation action is retried.

## How this mode can be used safely

Continue bounded, user-authorized source changes and independent tests/review in the
current environment without invoking real paid executors. Do not execute untrusted
agent-generated programs outside their permitted environment, pass secrets to workers,
interpret task text as permissions, or advertise this as OS-enforced isolation.

If the user wants later development milestones to proceed in an explicitly host-assisted
preview before original G2 passes, that is a forward-looking dependency/acceptance
change requiring explicit approval and a separate baseline. It must preserve the original
G2/G8 results as unverified and cannot waive system permission restrictions. This document
is an assessment, not that approval or a substitute adapter.

## Observed result

Coding and separate read-only review completed the bounded task successfully.
Changed code: tests/unit/schema-parity.test.ts only (no production behavior changes).
23 new tests cover entrypoint IDs/roots, shared definition consistency, nested reference
resolution, and deterministic runtime fixtures. This is structural schema consistency
and positive-fixture coverage, not a general JSON Schema validator equivalence proof.

Coding role ran offline frozen install, focused tests, lint, typecheck, full tests,
security tests and build. Read-only review independently ran focused tests, lint,
typecheck, full tests and security. Both observed 480/480 full tests and 63/63 security
checks passing; focused tests passed 23/23. No substantive review defect was found.

Reviewed test SHA-256:
`d040e5fc5506ae6fb338f15c0eecdb2cbfc27950e9b9258fb43fc54ab534bd92`.

No external provider invocation, credential read, privilege escalation, new cloud task,
environment transfer or retry of the denied isolation probe occurred in this exercise.
Native-service model/version/cost telemetry is NOT_VERIFIED, not assumed free or zero.
Final remote commit and CI provide the publication/verification record for this change.
