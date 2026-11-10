# M1 offline runtime runbook

Node 24.22.1, pnpm 11.25.0, POSIX/Linux. SQLite remains experimental in Node 24;
normal experimental warnings are not errors. No paid model credential is needed.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm verify
pnpm forge init --state-dir /path/to/new-private-state
pnpm forge doctor --state-dir /path/to/new-private-state
```

A task JSON may contain id, title and repo (the authorized repository URL), plus
low-risk bounds, existing dependency IDs and acceptance references. It cannot grant
permissions. This is an explicitly submitted offline fixture, not a real coding task.

```json
{"id":"demo","title":"Offline recovery demo","repo":"https://github.com/oahc09/ai-agent-forge"}
```

```sh
pnpm forge tasks add demo.json --state-dir /path/to/new-private-state
pnpm forge tasks run demo --dry-run --state-dir /path/to/new-private-state
pnpm forge tasks run demo --fixture approval --state-dir /path/to/new-private-state
pnpm forge approval list --state-dir /path/to/new-private-state
pnpm forge approval decide CARD_ID --approve --state-dir /path/to/new-private-state
pnpm forge tasks run demo --state-dir /path/to/new-private-state
pnpm forge tasks why demo --state-dir /path/to/new-private-state
pnpm forge status --state-dir /path/to/new-private-state
node apps/daemon/src/index.ts /path/to/new-private-state --once
```

Compiled alternatives live under dist/apps/cli/src/index.js and dist/apps/daemon/src/index.js.
Without --once, the daemon processes eligible fixed Fake tasks, idles without any worker,
and reconciles expired leases. Stop with SIGTERM. On restart it reuses the same private DB.
Do not run real candidate/third-party code under this account or grant it the state directory.

On unknown effects: task is QUARANTINED, not automatically retried. Preserve database,
why audit and local evidence; manual reconciliation tooling is not yet implemented.
On budget exhaustion: no new invocation is made, reason appears in tasks why.
On three failures: retry is refused. Between retries exponential backoff applies.
Approval denial cancels/revokes the grant. Repeating a decision is refused.
There is no CLI capable of raising permissions, changing runtime budgets or merging.

Backup/restore automation is M7 and not claimed here. For investigation stop the daemon
and preserve the state directory including SQLite WAL/SHM files; never copy only an active
DB file or delete evidence to make a test pass.

## Read-only readiness diagnosis

`pnpm forge doctor --readiness --json` works before `init` and does not open or
create a state database. It inventories codex/opencode/pi/bwrap using filesystem
metadata in absolute PATH directories only. It does not execute even `--version`,
read credentials, contact providers or probe isolation. PRESENT means only that
an executable file was found, not that it is trusted, configured or usable.
UNKNOWN means metadata/access could not be checked reliably; NOT_FOUND is limited
to the inspected PATH. Paths and environment contents are not included in output.

The result always retains productionReady=false and G2=NOT_VERIFIED. It lists
separate implementation, authorization, isolation and real-evidence prerequisites.
This is an actionable inventory, not a gate validator or an authorization source.
The prior sandbox denial in docs/m2-blockers.md remains historical evidence; the
command does not retry it or claim it describes every future machine. Do not
substitute two native host roles or installed binaries for real adapters. Native
host-service cost remains unmeasured, never assumed zero. Other doctor forms and
the fixed offline runtime are unchanged.
