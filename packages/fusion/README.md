# Offline fusion decision preview

`FusionPreviewRouter` probes existing `AgentAdapter.capabilities()` without calling
`start`, then produces persistent, explainable routing decisions in the existing
EventStore database. Host-approved profiles, scope, skills, independent score evidence,
adapter allowlist and invocation budget determine the route. Inputs to this API must
come from the trusted host, not candidate text; opaque policy references are not an
independent credential/authorization verifier.

Strategies: capable single adapter first; complementary two-specialist chain when no
single can cover the task; distinct coder/reviewer bindings on request; bounded
fallback using an accepted `ContextBroker` handoff. Fallback cannot expand original
scope, skills, policy reference, adapter allowlist or total task budget. Prior adapter
IDs cannot cycle back, at most two takeovers are allowed, and each parent has at most
one child decision. Exact repeated decisions consume no further reservations. Root
rerouting cannot reset the task budget. Capability probes have cancellation and a
bounded timeout. Decisions, reservations and accepted capsules persist across restart.

These are **routing decisions**, not an adapter execution engine. The host must execute
plans sequentially or independently as indicated, terminate processes, enforce paths,
and verify independent evidence. SDK metadata does not prove two heterogeneous real
executors exist. Shared budget reservations count planned host invocations, not paid
provider usage or measured latency. Profiles are pinned; no real performance benefit
is inferred from fixture scores. Every decision says `gain: NOT_PROVEN` and
`mode: host-assisted-preview`. G2/G3/G8 are not passed by these tests.
