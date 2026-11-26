# Host preview runbook

This is a local development and fixture rehearsal, not a production deployment.
Use the existing repository and current authorized environment. Node 24.22.1,
pnpm 11.25.0 and the committed lockfile are required. Never inject provider tokens.

1. Check out the reviewed commit in a clean worktree. Install using
   `pnpm install --frozen-lockfile --ignore-scripts` (set `--store-dir` to a writable
   path if needed). Initial dependency metadata downloads may be required even
   with a populated offline store. Do not bypass supply-chain checks.
2. Run `pnpm verify PREVIEW`. Inspect each command's exit code and immutable hashed
   evidence, not just the final summary. This runs the existing runtime regression
   and new library tests, including security cases. No live model is invoked.
3. Read docs/host-assisted-preview.md and the original plan's gate matrix before
   interpreting results. The CLI has no new provider, PR, Radar or evolution service.
4. For a local host integration, instantiate EventStore only in a private state
   directory validated by the existing runtime state-directory path. Keep its DB
   handle and trusted callbacks outside candidate access. Memory/triggers/pilot
   records share its consistent transaction/backup boundary. State hashes do not
   protect against a malicious process with the same UID.

## Backup/restore drill

Run `pnpm exec vitest run tests/integration/backup-preview.test.ts`.
The test uses Node's SQLite backup API, not a raw copy of a live DB. It restores into
a new temporary database, checks ten original tasks, excludes a post-backup task,
replays immutable events, checks the trigger audit and verifies the source remains
unchanged. The temporary test directory is then removed. Do not overwrite live state.

For real operational recovery, stop all writers, preserve source and WAL/SHM evidence,
make a SQLite-consistent backup into a new private destination, verify it, then
review the restoration before changing the runtime's state path. No automated
production recovery or permissions changes are provided in this preview.

## Candidate rollback and incidents

The evolution package's proposal/rollback metadata is rehearsal only. It does not
modify running code. Production rollback needs an explicitly approved deployment
and verified compatible schema; do not downgrade a live DB by checking out old code.
For a code-review rejection, retain the branch and evidence, revise the candidate
under the same review workflow; do not merge, deploy or force-push.

On unknown effects, integrity errors, unresolved grants, missing pilot days, cost
uncertainty or isolated-evaluator failure: stop the relevant execution, preserve
records, mark NOT_VERIFIED/BLOCKED, and request the specific missing authorization
or evidence. Never retry the documented denied namespace probe to evade restrictions.

## Still required for a real release

Actual safe provider adapters and OS isolation, authorized budgets and credentials,
real bootstrap/recovery, 72-hour soak, real source/license inspections and transfers,
protected real experiments/hidden tests, two real repositories, independent security
and RC review, and the real thirty-day G8 protocol. A complete fixture ledger cannot
satisfy any of those real-execution requirements.
