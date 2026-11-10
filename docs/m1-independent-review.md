# Independent M1 review — 2026-11-08

Reviewer: separate read-only QA reviewer, not the implementation workers.
Scope: fixed Fake M1 runtime only; not real-provider execution or M2 isolation.

Found and fixed:
1. DONE/CANCELLED tasks could become QUARANTINED. Both quarantine and policy-violation
   transitions now reject all terminal states, with explicit negative regressions.
2. Expired grants prevented denial of a pending approval. Expired approval still cannot
   resume, but denial can close the original scoped card and cancel the task.

Reviewer independently re-ran the corrected full suite: 372/372 passed; separate security
suite 45/45 passed. No remaining blocking defect found in the reviewed M1 Fake scope.

Additional independent observations:
- Total budget=1 and pending approval survive reopening; approving cannot bypass budget.
- Raising persistent limits silently is rejected, and old approval decisions cannot replay.
- State-root and DB symlinks are refused.
- Killing a host running a hang fixture causes its worker PID to disappear through IPC disconnect.
- Fixed credential-free Fake, same-UID trust boundary and lack of real Coder/Validator/Reviewer
  are explicitly documented rather than presented as production isolation.

Final exact-commit clean verification and remote CI must still be checked for delivery.
G0 continuation approval is separate and already provided by the user. This review does
not authorize paid providers, merge, deployment or any G2–G8 product claims.
