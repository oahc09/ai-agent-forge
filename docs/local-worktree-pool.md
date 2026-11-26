# Local Worktree allocation (M2-04 partial implementation)

`packages/execution/src/worktrees.ts` provides LocalWorktreePool for a **trusted
host controlling an explicitly authorized local repository**. It performs real Git
worktree operations and raw-blob materialization. It does not run candidate code,
launch a provider, contact a remote, or provide an OS sandbox. G2 is unchanged.
Do not give a candidate the pool instance, source metadata, pool manifests or this
host identity. The standalone CLI/daemon are not wired to this API.

## Allocation

The host supplies a canonical source directory and a canonical existing parent for
a fresh private pool root. Symlink source/root paths are refused. Each request has
only taskId, workerId and a full immutable 40-character commit SHA; it cannot select
a target directory, executable, arguments or environment. Mutable refs are rejected.

The pool allocates a separate detached, locked Git worktree for each active task
and worker. IDs and directory names are host-generated. Reservations are limited
to 32 active/uncertain leases and 1000 historical leases per pool instance. Returned
lease snapshots cannot rewrite the internal source/destination. Pool-root inode
changes are refused. Separate pools are not a global scheduler or cross-process
lock; the trusted host must provide that coordination.

Materialization uses worktree add --no-checkout, a separate index built with
read-tree, and raw cat-file blob reads. It avoids smudge filters and checkout hooks,
uses no shell, and strips inherited Git environment. Git comes from the fixed host
system PATH (/usr/local/bin:/usr/bin:/bin), not a task-selected executable. System
and global Git config, optional locks, lazy fetch, replace refs and network protocols
are disabled per invocation. Source and candidate worktree-specific config are
checked before Git use; include/includeIf/filter/alias/credential configuration and
escaped config are conservatively refused. Repository config is not rewritten.

Only regular blob entries are supported; symlinks and submodule gitlinks are rejected
before allocating a candidate. Paths use a restricted ASCII component set, cannot
be absolute, contain dot/parent segments or any .git component, or collide by case.
Limits are 10000 files, 1 MiB per blob, 16 MiB total, 2 MiB tree metadata and ten
seconds per Git subprocess. Unsupported repositories fail closed instead of silently
changing contents. Files are newly created, not hard-linked to the source.

## Cleanup and interrupted work

release requires an owned ready lease, unchanged worktree identity/commit and exact
tracked-file hashes/sizes/modes. Modified/deleted files, untracked or ignored files,
new empty directories, symlinks and candidate commits are preserved. Git's final
non-forced remove also refuses staged-only modifications. No reset --hard, clean,
force removal or prune is used. A failed Git cleanup is marked quarantined, retains
its reservation, and needs operator reconciliation; it is not automatically retried.

Manifests outside candidate directories retain source commit, file hashes and lease
state using atomic rename. They are inspection records, not authorization tokens or
the runtime's task source of truth. They are not fsync-backed crash certification.
Creation failures preserve partial worktree/manifests and quarantine the reservation.
There is no automatic restart import, recovery deletion or trusted re-adoption yet.
After host failure, inspect the retained manifests and Git registrations manually.

## Security boundary and remaining gate

Separate worktrees and defensive path checks are **not** protection against a hostile
process running as this host user. Git object storage/metadata remains shared, and
same-UID concurrent path/config replacement is not proven race-proof. Individual
file reads use no-follow/nonblocking descriptors, bounded reads and inode checks,
but this does not replace filesystem/process/network/CPU/RAM isolation. No untrusted
worker may execute in these directories until an independent authorized isolation
backend is installed and verified. The earlier denied bwrap probe is not retried.

Integration and security tests create real disposable Git repositories and worktrees.
They verify pinned raw contents even with Git replace refs, independent writes,
source preservation, config/hook rejection, path/type/size restrictions, and
non-destructive cleanup. Those results cover only the documented trusted-host
Worktree component. M2-04 OS isolation and original G2 remain unverified; Provider
execution, credentials, paid usage, environment transfer, merge and deployment are
not introduced by this increment.
