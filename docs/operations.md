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
