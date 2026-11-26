# ContextBroker (M2-05 offline scope)

A broker instance is bound to exact `(repo, branch, taskId, sourceVersion)` scope.
It accepts immutable capsule IDs, rejects cross-scope reads/writes, checks expiry
at admission and read, and returns independent copies. Missing/expired capsules
return undefined only within the bound scope. Audits contain IDs/actions/times,
not fact text or evidence contents. This is in-memory and does not imply durable
storage, tenant authentication or an OS/process boundary.

The constructor requires a **trusted host** `VerifyEvidence` callback. Each fact
labeled `verified` must reference known SHA-256 evidence and pass that callback
with the fact, corresponding evidence references and exact scope. The host must
actually compare evidence content, digest, version and claim; an unconditional
`true` verifier is suitable only for explicit test fixtures. Model/adapter text
must never choose the callback or determine its return value. The broker does not
fetch evidence. `acceptedBy` is descriptive provenance, not an authorization key.
Caller-only verification labels are rejected when evidence verification fails.
Inferred facts remain inferred, even when a verifier could confirm other facts.

Capsules include goal, verified/inferred facts, read-only evidence, changed commit
IDs, failed experiments, open questions, next steps, confidentiality and lifetime.
Capsules containing unknown fields, direct policy/grant fields, malformed evidence
or recognizable credential patterns are rejected. Pattern checks are limited and
cannot prove arbitrary prose secret-free. Hosts remain responsible for sanitizing
context before admission. `public`/`internal` are labels, not access grants.

Historical facts and instructions are always **data**, never current policy. The
broker exposes no command execution, network, permission issuance or policy
mutation API. Instructions such as “ignore policy” in fact text cannot modify run
permissions. A real integration must apply trusted current policy independently.
No native cross-model session migration, real provider calls, cross-process
isolation, automatic privilege filtering or G2 completion is claimed.
