# Host-assisted AutoDev preview

`HostAutoDevPreview` uses the existing privileged SQLite `EventStore` as task truth.
Intake receipts, approved plans, callback reservations, leases, attributed evidence,
local delivery drafts, reconciliation observations and audit records persist in the
same database. The host must keep this database and API out of worker reach.

- `intake(metadata, body, plan)`: authenticated connector metadata and host-approved
  plan are separate from external body text. Only a digest of body text is stored.
  Actor/repository/label/source checks precede admission. Same event and payload are
  idempotent; changed payload under the same event identity is rejected.
- `claim()`: dependency readiness, priority, resource capacity, path/worktree
  conflicts and concurrency are checked transactionally. Claims are fenced by an
  exact run ID, random lease token and deadline. Only the `fake.run` policy grant is
  issued. No permission is obtained from external text.
- `run(lease, callbacks)` / `drain(callbacks)`: trusted host callbacks implement,
  validate and review. Approved acceptance IDs and artifact hashes must match.
  Settled negative checks allow at most three attempts; exceptions, unknown effects
  and invalid contracts quarantine instead of blindly retrying. Invocation budgets
  count every callback. Timeouts/cancellation stop accepting output, but cannot force
  an arbitrary host callback to stop; the host owns process termination/isolation.
- `recoverExpired(taskId, observation)`: after restart, the host must first reconcile
  the interrupted callback. Verified no-effects allows bounded retry; unknown effects
  quarantine. This is not proof that an untrusted process cannot create effects.
- `draft(taskId)` produces an immutable, local-only candidate package. Commit/path/
  digest claims are supplied and verified by host callbacks. No Git operations or
  commit creation are implemented. `reconcileDelivery` stores trusted observations,
  never queries or writes GitHub. An absent observation does not authorize delivery.

Use one privileged coordinator per database; do not mix this preview lifecycle with
another active scheduler. Configuration and role bindings are pinned across restart.
No credentials, paid providers, remote writes, merges, isolation probes, or actual
agent autonomy are provided. Separate role bindings are a host contract, not verified
process/account independence. Evidence is simulation/host-assisted preview only.
G2, G3 and G8 remain unpassed; a repeated local draft is not a real PR acceptance test.
