# Detached candidate workspaces (M2-04 partial)

An ordinary Git worktree points at shared host metadata. It must not be mounted
as-is into an untrusted runner with writable access to that metadata. The new
LocalWorktreePool.detach(leaseId) prepares fresh ordinary file copies, excluding
all Git metadata. It first rechecks the owned ready lease's commit, Git marker,
paths, modes, sizes and hashes against its creation baseline. Changed or released
leases cannot be exported. Verified file modes are preserved exactly with descriptor-based chmod, including
600/700 baselines created under umask 077; a later host umask cannot silently
redefine the baseline. Copies are neither symlinks nor hardlinks and remain
available after releasing the original clean worktree. At most 32 exports can be
created per pool instance; failed attempts also consume the retained-history quota.

The returned CandidateWorkspace stores identity and baseline in host memory,
outside the candidate directory. It does not expose a writable baseline manifest
to a worker. The baseline digest binds task/worker/lease/commit and the sorted file
metadata. This is not a signature, proof of execution, durable recovery journal or
user authorization. Direct construction of CandidateWorkspace accepts a trusted
host-provided baseline; only the pool's detach path verifies that baseline against
a pinned Git lease. Do not accept a candidate's claims as that verification.

After a runner has fully stopped and the trusted host has exclusive access,
inspect() reports sorted added/deleted/modified files, hashes, sizes, permission
modes and directories. A mode-only change is included. Empty directories affect
the candidate digest and are listed separately, not silently interpreted as Git
changes. Returned data are detached copies; mutating them cannot rewrite the
baseline. No file bodies, provider output, credentials or logs are returned.
There is no Git invocation during inspection and no automatic patch application,
staging, commit, cleanup or upload. All candidate bytes remain for review.

Inspection refuses symlinks, hardlinked files, special files, setuid/setgid/sticky
file bits, changed root inode, cross-device entries, unsafe paths (including any
.git component), case collisions and resource excess. Limits are 10000 files,
20000 total entries, 1 MiB per file, 16 MiB aggregate and 64 directory levels.
Directory enumeration is incremental and bounded. File reads use no-follow,
nonblocking descriptors, inode checks, bounded reads and before/after metadata.
Errors do not echo candidate content or paths. Failed inspection preserves files.

## What this does not solve

This is a data transport and review primitive, not a sandbox. Same-UID concurrent
mutation is not proven race-free, ancestor and sibling paths (including the original Worktree and shared Git
metadata) remain host-accessible, and Git
commands could discover ancestor repositories if run directly here. Do not run
candidate code here without a separately authorized, verified isolation backend.
A future backend must mount only the detached candidate at a fixed guest path,
exclude host/ancestor Git metadata, enforce read/write and network policy, and
bound processes, memory, CPU and time. Filesystem inspection cannot enforce those
rules, attest process cleanup or prove a remote provider stayed within budget.

Exports and baselines are process-local; there is no crash recovery, cross-process
quota or automatic deletion. There is no standalone CLI wiring or real adapter
launch. Tests exercise real local Git allocation, file copies and adversarial
filesystem entries only. Original G2/G8 are unchanged. Provider authorization,
secure credentials, two real heterogeneous executors, ten-task E2E evidence and
real isolation tests remain outstanding. No denied isolation probe was retried.
