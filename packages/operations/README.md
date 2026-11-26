# Trusted-host operations preview

`TriggerRouter`, `ProjectMemory` and `PilotLedger` use the existing EventStore's
SQLite transaction boundary. They are privileged host APIs, not candidate tools.
The runtime CLI does not yet expose them. Direct Node 24 imports, compiled imports
and TypeScript tests are supported; no credentials or providers are required.

TriggerRouter binds a frozen copy of source/repo/actor/label/cost/value rules and
observe/auto mode. Repeated identical event metadata/body is idempotent, changed
payload conflicts. The untrusted body is hashed but never parsed into authority.
Auto returns ELIGIBLE with executed=false; it is not a runtime execution grant.

ProjectMemory binds exact repo, branch, task and source version. Capsules use the
existing ContextBroker schema/evidence checks and are persisted with immutable IDs.
Retrieval rechecks verified evidence and TTL; final results exclude records that
expire while other records are verified. Archive is explicit, expiry archives old
records. No cross-task/project semantic memory or automatic context injection is
implemented. Search is deterministic substring ranking; twenty-fixture recall is
not a real-work benchmark. Return values do not alias stored facts.

PilotLedger requires a thirty-day UTC preview protocol, at least thirty distinct
predefined task objectives and acceptance criteria, and a conservative cost cap.
Protocol hash is immutable across reopen. Host-authorized dependency-ready claims
reserve budget before admission and consume it even on failure. Failed, blocked,
timed-out and unresolved claims remain in the denominator. Routine approvals and
human guidance are distinct records; recorded guidance cannot be omitted from the
humanAssisted flag. Outcomes include host-recorded completion time. Late outcomes
retain cost and denominator but not numerator; backdated-before-claim recording is
rejected. No host-supplied claim can report G8 success: all summaries are
NOT_VERIFIED. Missing fully elapsed daily reports are listed; reports and results
are immutable/idempotent. No notification or actual trial scheduler runs here.

State does not prove real execution, evidence truth, independent reviewers, wall
clock integrity, model charges or human nonintervention. A trusted host is responsible
for those observations. No real-mode API, OS isolation, thirty-day pilot, 72-hour
soak, or paid spending is provided. See ../../docs/host-assisted-preview.md.
