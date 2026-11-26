# Offline evolution preview

This package has no network, subprocess, filesystem, provider, adoption, merge or
stable-instance modification API. Every constructor is a privileged trusted-host
API. It must not be exposed directly to candidate/model code. Same-process input
validation and frozen copies do not establish OS-level isolation or independent
reviewer identity.

## APIs

- `validateGene` checks a strict versioned proposal schema: pinned source commit,
  per-file evidence hashes, license/NOTICE/SBOM/safety references, mechanism,
  applicability, risks and exact permitted files. `GeneRegistry` retains immutable
  versions, invokes a host evidence verifier before eligibility, supports review
  revision, invalidation/revalidation and permanent revocation. The verifier must
  resolve actual evidence bytes and authenticate review decisions outside this
  package. It cannot promote an `unverified-proposal` into a verified real transfer.
- `proposeTransfer` checks reviewed eligibility, baseline, target changes, digest
  changes and conflicts with pending proposals. Revoking or invalidating a gene
  revokes its pending transfers. No adopted commit or accepted-transfer count can
  be supplied by a candidate. New versions use distinct IDs; old records remain.
- `OfflineExperiment` freezes a complete synthetic task manifest, model/tools,
  environment, commits, per-task budget, critical slices and bootstrap settings.
  `inspectChanges` freezes canonical source-file paths before observations. Any
  protected, traversing, ambiguous or out-of-scope path quarantines the candidate.
  This is lexical diff metadata validation, not a symlink-aware filesystem sandbox.
- `record` admits only paired synthetic records matching that frozen manifest.
  Duplicate tasks, missing failures, mismatched controls, invalid numbers or excess
  cost are rejected. Batch insertion is atomic. `report` requires every task and
  preserves all raw records plus hashes, success/cost/median latency, slice effects
  and deterministic paired-percentile bootstrap intervals. Its thresholds mirror
  the plan's +5pp, positive CI lower bound, <=10% cost/success increase, <=2pp key
  slice regression and zero safety violations, but only as fixture assertions.
- `OfflineSearch` reserves a nonrefundable synthetic budget for at most five
  candidates and retains failed/cancelled/pending results. It does not generate or
  execute candidates, perform autonomous hill climbing, or authorize real spending.
- `proposePromotion` produces only rejected or manual-independent-review metadata;
  `proposeRollback` produces a policy-approval-required restoration plan tied to a
  proposal. Neither is an executable authorization or a record of a real promotion
  or rollback. There is intentionally no approval-token bypass.

## Evidence limits

All benchmark inputs must say `simulation`; `provider-real` is explicitly rejected.
All reports say `NOT_PROVEN` and G8 `NOT_VERIFIED`, including perfectly positive
fixtures. Local manifest hashing is not authentic independent preregistration.
No real independent evaluator, hidden confirmation samples, multiple-comparison
protocol, real provider run, genuine source migration, actual isolated experiment,
production promotion or rollback drill has been performed. Those requirements and
G2/G5/G6/G8 remain unmet; passing these tests does not pass those gates.
