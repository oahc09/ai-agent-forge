# FakeAdapter (offline only)

`FakeAdapter` exercises the SDK without importing shell, filesystem, network or
model clients. It never acts on command/network/path permission declarations and
never spends token/call/cost budgets. Real model adapters are **not implemented**.

Options configure deterministic output chunks, per-chunk delay, failed attempt
numbers and required context. Options and all emitted events are validated.
Cancellation works through AbortSignal or `cancel(runId)`; it wakes pending delay
without waiting for the full timeout. Terminal events are explicit. Consumer
backpressure counts toward the monotonic wall-clock deadline. Inputs are copied
at `start` and revalidated at first iteration, including context expiry.

A failed attempt is not retried automatically. Callers must decide retry policy,
provide a new run ID, and advance the attempt. Every consumed run ID is one-use per
adapter instance, including when the consumer closes an iterator early. Iterator
close (including `return`/`throw` before the first pull) cleans listeners and active-run state but cannot emit a terminal event to a
consumer that has already stopped reading. A close aborts a pending delay and
suppresses its pending event delivery. A subsequent cancel of an inactive ID
is an idempotent no-op. Cancellation is reserved at `start`, so `cancel(runId)` works before first
consumption as well. No AbortSignal listeners are attached before consumption.
Pending/active reservations are capped at 256; cancelling an unconsumed run frees
its reservation while its iterator retains the cancelled state.

Capabilities truthfully report streaming/cancellation and summary handoff, with
`resume: false` and `toolCalls: false`. This fake does not claim native resume,
actual agent execution, OS sandbox enforcement, or G2 passage.

## Provider protocol groundwork

CodexJsonlDecoder and OpenCodeJsonlDecoder implement distinct JSONL lifecycle and
usage translations into SDK events. They do not launch either provider or implement
runnable AgentAdapters. They require trusted process-exit evidence before success;
OpenCode step_finish alone never completes a run. See
[protocol contracts and remaining work](../../docs/provider-protocol-adapters.md).
