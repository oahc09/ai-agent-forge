# Independent host-preview review

Date: 2026-11-08. Scope: the user-approved trusted-host preview, not the original
G2–G8 product acceptance. A separate read-only reviewer inspected new AutoDev,
Fusion, operations, Radar/evolution, tests, verification changes and documentation.

## Findings fixed and independently retested

- AutoDev deferred implementation could start after immediate cancellation.
  Authoritative lease and abort checks now run immediately before callback entry.
- Fusion deferred capability probes could start after cancellation; fixed similarly.
- Fusion retained mutable adapter identity inconsistent with persisted configuration;
  pinned identity and pre/post-probe drift checks now reject it.
- Memory archived by its evidence verifier could still appear in the same retrieval;
  final results now recheck archive state as well as TTL.
- Pilot accepted outcomes recorded after the thirty-day window could inflate its
  numerator; persisted observation timestamps now exclude late results while
  preserving denominator/cost, including after reopen. Before-claim recording fails.

Earlier implementation/cross-review also fixed forged lease deadlines affecting
callback timeouts, reentrant gene revocation being overwritten, and memory scope
key-order/expiry boundaries. Dedicated regressions are included.

## Independent executed checks

- Full suite: 622 tests across 23 files, passed.
- Security suite: 123 tests across 6 files, passed.
- TypeScript strict typecheck, ESLint, build and diff whitespace check, passed.
- Additional probes: cancellation starts zero callbacks/probes; adapter identity
  drift before/during probe denied; immediate archival honored; late pilot results
  remain excluded across reopen; concurrent budget enforcement; exhausted recovery;
  routing decision idempotency.

No remaining concrete Major/Blocker was found in the documented trusted-host scope.
This review is a separate development role, not OS-isolated product evaluation.
The reviewed source-file digest manifest is host-preview-review-hashes.json.

## Exact-source verification requirement

Dirty development test reports were explicitly NOT accepted as reconstructable
commit evidence because Git diff excludes untracked files. Publication requires a
clean checkout of the reviewed committed tree, fresh full verification, matching
artifact byte hashes and CI for that exact remote commit. Those generated reports,
not this prose, carry the final evaluated commit and cleanliness.

Original G2 remains blocked. G3–G7 and G8 remain NOT_VERIFIED. No live provider,
autonomous product run, safety isolation, real gain, production promotion, merge,
release or deployment was performed or approved by this review.
