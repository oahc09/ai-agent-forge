# M1 domain contracts

`src/index.ts` exports strict runtime validators, task/event types, defaults,
classified `DomainError` codes and the deterministic task reducer.
`schemas/*.schema.json` publishes the matching JSON Schema 2020-12 contracts.
Runtime checks additionally enforce valid calendar timestamps, self-dependency
rejection, retry bounds and authorization/state invariants.

Only the M1 task event registry is implemented. Later experiment, gene, fusion,
evolution and campaign event families from the plan are not accepted yet.
A task can be created only as DISCOVERED with zero attempts/version, no lease,
and no permissions. Permissions originate exclusively in trusted kernel
policy assertions. Claim/start/heartbeat/recovery and authenticated approval
resume have explicit guards. DONE requires an explicit delivery classification;
merged delivery additionally requires a trusted approval reference.

Worker text is not authority. `KernelAuthority` is a trusted in-process host
contract, not an authentication mechanism. The scheduler must authenticate its
caller and derive this object from its persisted records. It must independently
verify report identity and approval signatures/identity; report strings alone
cannot be treated as independent validation proof. EventStore also requires a
passing current-attempt review before PR_READY.
