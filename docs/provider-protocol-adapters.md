# Provider protocol adaptation, not real execution acceptance

This increment implements the protocol-decoding portion of M2-02/M2-03, independently
for Codex exec JSONL and OpenCode run JSONL. It does not implement a process launcher,
provider client, sandbox, credentials, budget authorization, or two runnable real
AgentAdapters. REAL_ADAPTERS_IMPLEMENTED stays false. The CLI/daemon still uses Fake.
G2 remains NOT_VERIFIED. Hand-authored fixtures are not recorded provider executions.

## Sources inspected

Protocol behavior was inspected at these exact upstream revisions. No upstream code
or dependency is copied; implementations and fixtures are written for Forge's SDK.

- Codex `e54a5713caf331f42a6eef0166186df5f7563c29`:
  https://github.com/openai/codex/blob/e54a5713caf331f42a6eef0166186df5f7563c29/sdk/typescript/src/events.ts
- OpenCode `ed0171f08ac4018ae648fcca7315b3d717989d50`:
  https://github.com/anomalyco/opencode/blob/ed0171f08ac4018ae648fcca7315b3d717989d50/packages/cli/src/run/noninteractive.ts
  https://github.com/anomalyco/opencode/blob/ed0171f08ac4018ae648fcca7315b3d717989d50/packages/cli/src/run/run.ts
  https://github.com/anomalyco/opencode/blob/ed0171f08ac4018ae648fcca7315b3d717989d50/packages/schema/src/token-usage.ts
  https://github.com/anomalyco/opencode/blob/ed0171f08ac4018ae648fcca7315b3d717989d50/packages/schema/src/llm.ts

Installed binaries are not assumed to match these revisions. Version pinning and
compatibility checks belong to the future trusted runner. Upstream evolution can
require decoder updates and fresh independent tests.

## Contracts

Construct CodexJsonlDecoder or OpenCodeJsonlDecoder with a valid AgentRunInput.
Call acceptLine with one complete JSON line. It returns normalized SDK events,
using the host task/run identity and host timestamps, never JSON-supplied authority.
Pass every returned event to the consumer. Assistant text is buffered (4096 characters
total) until successful trusted exit, validated as one response and then emitted;
this preserves whitespace deltas and detects credential-like strings across records.
On failure/cancellation/timeout the buffer is discarded. Live text streaming is not
claimed by this protocol implementation. After all stdout is drained, call
finish with the actual observed process exit (null means unknown), or with a
trusted runner cancellation/timeout outcome. The decoder does not stop processes.
Never call finish using a model-supplied exit code or a tool's exit status.

Only finish can emit succeeded. It requires observed exit 0, complete provider
lifecycle and no malformed/unsupported record or provider failure. Codex turn
completion is not enough. OpenCode step_finish is especially not task completion:
there can be further tool steps, retries or background failures. Final stop reason,
all steps finished and successful process exit are required. Cancellation and
timeout must come from actual runner evidence, not inferred silence.

Output is limited to final agent message/text records, not reasoning, tool input,
tool output or provider errors. Tool observations never dispatch tools. Session
mixing, duplicate completion, unknown top-level events, invalid token counts,
credential-like output, oversized lines and missing terminal evidence fail closed.
Any parsing failure poisons the decoder; finish cannot subsequently grant success.
Each decoder consumes one run; retries require a new decoder and host-owned run ID.

reportedUsage returns copies of per-turn/per-step provider claims. Missing cost
or optional token dimensions stay null, never zero. OpenCode cost is a reported
USD estimate, not verified billing. No total is computed across potentially
provider-specific/cache-overlapping token dimensions. These records do not enforce
budgets, establish model identity or prove all underlying calls were accounted for.

## Explicit limitations and remaining work

- No process or model invocation, no account/credential handling, no permission or
  network change, no sandbox probe, no installed-binary upgrade.
- This is a conservative protocol subset, not guaranteed compatibility with every
  upstream option. Unknown item/event kinds, total output over 4096 characters, lines
  over 65536 UTF-8 bytes and streams over 10000 records are refused. No hidden or
  arbitrary third-party code is executed to test it.
- No byte-stream framing, process kill/reaping, stderr handling, runtime version
  attestation, real usage reconciliation, secure prompt input or model routing yet.
- No streaming delta duplication for Codex: only completed agent messages emit.
  OpenCode text records are accumulated as upstream deltas; host integration
  must retain its original ordered non-replayed stdout. Decoder does not reconnect.
- Native resume is not claimed. A future integration must use a new isolated
  session with validated ContextBroker handoff when recovery is necessary.
- Original ten shared real tasks, independent cancellation/failure/cost evidence,
  and filesystem/process/network/resource isolation remain blocked/unverified.

Tests: `pnpm exec vitest run tests/unit/provider-protocols.test.ts` followed by
normal full lint/typecheck/test/security/build checks. Tests validate protocol
contracts only and do not enable the runtime to use these providers.

## Subsequent transport rehearsal

A separate owned-process fixture now exercises framing, lifecycle, cancellation
and reaping with these decoders; see [offline-process-adapters.md](offline-process-adapters.md).
The missing real-provider runner/isolation requirements above remain unchanged.
