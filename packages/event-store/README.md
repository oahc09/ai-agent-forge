# M1 event store

`EventStore` is a privileged, synchronous Node 24 host API using built-in
`node:sqlite`. Candidates and worker processes must not receive its database
path, database handle, or an import path into the running host. The caller is
responsible for authenticating the operator and resolving policy, approval,
lease-token, dependency and side-effect records in a transaction. A
`KernelAuthority` is the resulting trusted assertion, never a worker payload.
It is not a cryptographic capability or a substitute for OS isolation (M2).

The store checks schema, expected aggregate version, state-machine invariants,
lease timing, required authority assertions and idempotency before appending.
An idempotency key is global: an exact repeated command plus authority returns
its original result, even if the aggregate has advanced. Reusing the key with
changed input fails. The kernel, not a model, chooses keys.

`transaction(fn)` uses BEGIN IMMEDIATE at the root and SAVEPOINT for nesting.
Callbacks must be synchronous. Kernel tables and `append` can share the same
transaction through the privileged `db` property. Errors roll back both event
and projection writes. WAL and synchronous=FULL are configured; actual power
loss durability still depends on the operating system and storage hardware.

Migration v1 creates an append-only event table, task projections, and immutable
snapshots. SQL triggers reject normal event/snapshot update and deletion.
A database administrator can remove triggers; this is not protection against a
compromised host/database owner. Future migrations must preserve original
schemaVersion and events. Unknown migration versions fail closed.

`replay()` folds the complete immutable log and compares stored event results
and snapshot checkpoints before replacing projections in one transaction.
Snapshots preserve incremental checkpoints but do not currently accelerate
replay. Raw events remain authoritative. Event authority metadata is stored
alongside the event for deterministic replay, never accepted from worker text.
Only references/reasons belong in event payloads: unknown properties, including
permission/password fields, are rejected. Free-text strings are not a secret
scanner; the kernel must avoid inserting credentials in those strings.

Tests cover all explicit state-edge combinations, duplicate delivery, stale
versions, mutation isolation, malformed schemas, immutable tables, nested
transactions, 10,000-event replay, snapshot corruption, injected exceptions,
and SIGKILL between event/projection writes. They do not prove storage-device
power-loss behavior, distributed exactly-once delivery or M2 worker isolation.
