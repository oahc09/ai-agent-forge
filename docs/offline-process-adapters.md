# Owned-process transport rehearsal

This increment connects the Codex/OpenCode protocol decoders to the AgentAdapter
lifecycle using actual, repository-owned Node subprocesses. It is an offline
transport rehearsal, not two real coding executors and not OS isolation.
REAL_ADAPTERS_IMPLEMENTED remains false; G2 remains NOT_VERIFIED. The CLI and daemon
are unchanged and do not select these adapters.

## What runs

CodexFixtureProcessAdapter and OpenCodeFixtureProcessAdapter each implement start,
cancel, capabilities and a bounded observation lookup. Both launch ONLY the fixed
`offline-process-worker` next to their transport code, using the current absolute
Node executable. They choose different protocol encodings and use their distinct
production-protocol decoders. The fixture does not interpret task text or execute
commands, tools, files, networking or child processes. It cannot be replaced by
passing an executable, command string, environment, cwd or script in task input.

The worker runs in a new temporary directory with ignored stdin, piped stdout/stderr,
no shell, no inherited NODE_OPTIONS/execArgv, HOME, PATH or credentials. Its only
environment entries are NODE_NO_WARNINGS and LANG. Task cwd/read permissions are
not filesystem grants; the worker does not read them. Command/network/write-path
declarations and nonzero provider budgets are refused before launch. Timeout is
bounded to five seconds, and the launch does not spend a provider budget.

These are trusted-host safeguards around known test code, NOT a filesystem,
network, UID, CPU, RAM or process-tree sandbox. A malicious replacement of the
repository or Node executable is outside this fixture trust boundary. No third-party
code may be substituted. The worker does not spawn descendants, so direct-child
termination here does not prove general process-tree cleanup.

## Transport and lifecycle

- stdout framing preserves split UTF-8, CRLF, and a final complete JSON record with
  no LF; invalid UTF-8/JSON and decoder errors fail closed without returning raw input.
- Each line is at most 65536 bytes; stdout is limited to 1 MiB and stderr to 64 KiB.
  stderr is counted only and never logged/returned. Decoder output remains bounded
  to 4096 characters and is withheld until successful observed process exit.
- Timeout, caller abort, explicit cancel and iterator close terminate the direct
  child with SIGTERM, followed by SIGKILL after 100 ms if necessary. Return waits
  for close/reaping. A two-second cleanup watchdog reports cleanup-unconfirmed if
  reaping cannot be established; unknown cleanup never produces success and keeps
  its concurrency slot quarantined for operator investigation, even after cancel.
- A protocol completion followed by a hanging process times out instead of
  succeeding. Nonzero/unknown exit, parser failure and limits cannot become success.
- Unconsumed cancelled/closed iterators never spawn. Input is snapshotted and
  revalidated at first consumption. Each run ID is single-use; retries require a
  new run ID. Concurrent/pending reservations are bounded to 32, lifetime IDs to
  10000 and observation records to 128. Streaming/native resume/context handoff are
  not claimed; this fixture returns buffered SDK events after process completion.
- Observations bind the SDK run lookup to PID, runtime version, close status,
  reason and byte counts, plus unverified reported protocol usage. They explicitly
  set realProvider=false and isolationVerified=false. Fixture usage is not model
  billing evidence. The temporary directory is removed only after close; cleanup
  uncertainty is reported and never silently ignored as success.

## Verification and remaining G2 work

`pnpm exec vitest run tests/integration/process-adapters.test.ts` runs real local
fixture processes. It checks both encodings, split-byte framing, real PID exit,
malformed/oversized data, stderr suppression, ignored SIGTERM escalation, timeout,
late protocol completion, cancellation and iterator return races, input mutation,
pre-launch restrictions and stripped environment. Standard aggregate checks still
apply. These results are process-transport evidence only, never real model E2E.

A real provider integration still needs an independently reviewed, authorized
isolation backend; filesystem/network/process-tree/CPU/RAM enforcement; minimal
credential handling and real provider budgets; trusted runtime/model version and
cost reconciliation; two installed pinned executors; secure prompt handoff and the
ten shared real tasks. No arbitrary launcher or boolean 'sandbox approved' flag is
added here. The previous bwrap denial has not been retried, and no security setting,
provider account, environment selection or original acceptance threshold changed.
