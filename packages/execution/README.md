# Offline Adapter SDK (M2-01 partial milestone)

The `AgentAdapter` interface matches the v1.1 plan: capability discovery, streaming
`start(input, AbortSignal)`, `cancel(runId)`, and optional native `resume`. The JSON
schemas in `schemas/` were defined before the adapter and cover input, event,
checkpoint and handoff capsule. Their definitions drive the strict runtime
validator. Runtime validation additionally enforces cross-field scope, canonical
paths, duplicate/evidence relationships, validity periods and credential-like
content filtering. No coercion or unknown fields are accepted. Run inputs carry
purpose, read-only evidence references, explicit file/command/network declarations,
zero-compatible budgets, cwd, capsule or null, trace IDs and an opaque approval
reference. Approval references are lookup IDs, never credentials or bearer tokens.

`AgentEventStreamValidator` checks identity, contiguous sequence numbers, start and
terminal transitions, and incomplete streams. Call `finish()` when consuming an
external adapter stream. Only `running`, `succeeded`, `cancelled`, and explicitly
coded failures are supported. Output cannot change task/policy status directly.

Checkpoints permit **new-session-with-summary** recovery only. They contain no
native provider session state. Revalidate a checkpoint immediately before using
it, then construct a fresh run ID and explicit attempt. A schema-valid capsule's
`acceptedBy` and `verified` labels are not cryptographic proofs. Use the trusted
host's `ContextBroker` verification path before handing context to real consumers.

## Boundaries

- This is an offline protocol, not a permission issuer or OS sandbox.
- A declaration, approval reference or capsule does not authorize execution.
- Local evidence references use `artifact:`, `repo:` or `evidence:` opaque IDs;
  neither SDK nor FakeAdapter fetches them.
- Credential pattern rejection is defense in depth, **not general secret
  detection**. Trusted callers must supply sanitized context; arbitrary prose can
  contain secrets not recognizable by a pattern. There is no external transmission.
- Real adapters, provider cost/version accounting, native resume, persistent
  context storage and enforced sandbox isolation remain unimplemented here.
- Passing these offline tests is not G2 completion.

## Local Worktree management

Trusted hosts may import LocalWorktreePool from the separate src/worktrees.ts
module for pinned, distinct local worktree allocation and conservative cleanup.
It is deliberately not imported by the offline protocol-validator entrypoint.
It is not an OS sandbox or an authorization source. See
[boundaries and remaining M2-04 work](../../docs/local-worktree-pool.md).

LocalWorktreePool.detach copies a pristine owned lease into regular files without
Git metadata. The returned CandidateWorkspace inspects added/deleted/modified
files and mode changes as bounded hash-only metadata. This is an offline transport
component, not an isolated runner or patch-application authorization. See
[detached candidate workspaces](../../docs/detached-candidate-workspaces.md).
