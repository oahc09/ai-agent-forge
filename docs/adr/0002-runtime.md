# ADR 0002: single-node offline runtime

G0 continuation approved by user on 2026-11-08: “批准继续开发”.
Approval followed explicit request to begin M1 on the reviewed M0 baseline.
It does not approve paid providers, merging PR #1, deployment or lowering acceptance.

Node 24 node:sqlite, WAL, FULL synchronous, versioned migration, append-only events,
transactional projections and nested SAVEPOINTs. Replay validates and folds original
events, snapshot checkpoints validate integrity but are not yet replay acceleration.
The EventStore is a privileged host API; KernelAuthority is not a worker credential.
Workers only send fixed fixture messages through IPC. Policy issues scoped fake.run
records; Scheduler checks persistent grants, leases, budgets and approval cards.

Budgets reserve every invocation atomically before spawn and never refund failed calls.
UTC daily and total/task call limits persist across restart. Real monetary spending is
fixed at zero. Changes to frozen limits/policy require a separate future admin flow.
Lease expiry with any recorded effect quarantines for manual reconciliation. No remote
side effects are performed, so an empty ledger is sufficient only for this offline M1.

Authentication for CLI approvals uses OS owner identity of a private state directory
(0700) and SQLite file (0600), no self-declared --actor accepted. This protects against
other OS users, not malicious code running under the same UID. Candidate execution
with separate filesystem/process/network restrictions is M2, not claimed by M1.

Only fixed credential-free Fake subprocesses are supported. Approval waits fully exit
that subprocess first. If the host dies, IPC disconnect exits the fixture; persisted
leases are reconciled on restart. Daemon polling is lightweight, never a model loop.

Real adapter credentials, cost reporting, sandbox enforcement and independent real
Coder/Validator/Reviewer delivery are not implemented or implicitly authorized here.
Offline success/review report IDs are deliberately named offline-fixture and cannot
constitute a real development acceptance report.
