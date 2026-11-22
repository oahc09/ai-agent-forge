# G2 single-task offline receipt preflight

This is preparation for the first executor pilot, not a pilot result. The
original G2 and G8 stay `NOT_VERIFIED`. The M2 plan still requires real OS
isolation and two authorized real adapters; an isolated workspace copy does
not prove either. No provider, model, command, worker, sandbox, or deployment
is started by this check.

## Frozen offline fixture

`g2-single-task-is-even-v1` represents a workspace with one ordinary file,
`src/is-even.ts` (mode 0644), and only the `src` directory. The task fixes the
exact one-line JS/TypeScript parity predicate from `n % 2 === 1` to
`n % 2 === 0`. All other changes, noncanonical content, changed modes, added
directories, and altered identity or digests are rejected. The verifier
checks expected bytes by digest; it does not import or execute candidate code.
The fixture test uses a real `CandidateWorkspace` copy and `.inspect()`.

## Receipt trust boundary

`checkG2SingleTaskPilot` receives three separate inputs: host pins, the
read-only `CandidateWorkspace.inspect()` inventory, and two compact
`JSON.stringify` receipt strings (4 KiB each). The host supplies pins
out-of-band for the unique planned run, pinned source commit, lease, task,
worker, and two distinct non-worker issuer labels plus raw SHA-256 digests.
The inventory is obtained only after runner shutdown from the host's
exclusively controlled candidate; never treat a worker-supplied inventory
or receipt as a source of trust pins.

Both receipt shapes bind schema, issuer, run, task, lease, worker, commit,
candidate digest, and the fixed classification `offline-fixture`. The runner
receipt (schema `forge.g2-offline-runner.v1`) also binds its baseline digest
and zero fixture exit code. The independent receipt (schema
`forge.g2-offline-independent.v1`) must link the exact runner receipt digest
and say `fixture-bytes-match`. All fields are exact; extra status, approval,
shell, or path fields are refused. A positive result proves consistency only,
not external authenticity: no signature, key custody, issuer independence,
time freshness, persistent replay protection, OS isolation, real execution,
billing, or user approval is inferred. The host is responsible for unique
run identities and independent pin provenance.

Results are `BLOCKED_NO_TRUSTED_BINDINGS`, `REJECTED`, or
`OFFLINE_CONSISTENT`. Every result sets both gates to `NOT_VERIFIED`
and both `authorizesExecution` and `verifiedRealExecutor` to `false`.
This code is not an admission authority and is not wired to any executor.
