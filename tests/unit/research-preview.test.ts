import { describe, expect, it } from 'vitest';
import { OfflineRadar } from '../../packages/radar/src/index.ts';
import { GeneRegistry, OfflineExperiment, OfflineSearch, proposePromotion, proposeRollback } from '../../packages/evolution/src/index.ts';
import { gene, manifest, observation, pairs, sources, transfer } from './research-fixtures.ts';

describe('offline research preview', () => {
  it('ingests ten fixed fixture sources, merges repeated mechanisms and advances cursors', () => {
    const radar = new OfflineRadar(sources());
    for (const source of sources()) {
      const request = radar.begin(source.id, 0);
      expect(request.cursor).toBeNull();
      radar.complete(request, { observations: [observation(source)], nextCursor: 'page-2' }, 1);
      const incremental = radar.begin(source.id, 2);
      expect(incremental.cursor).toBe('page-2');
      radar.complete(incremental, { observations: [observation(source)], nextCursor: 'page-3' }, 3);
    }
    expect(radar.candidates()).toHaveLength(10);
    expect(radar.candidates().every(item => item.references.length === 1)).toBe(true);
  });

  it('merges release/commit references for one mechanism while preserving rejection', () => {
    const commitSource = sources()[0]!;
    const releaseSource = { ...commitSource, id: 'release-source', kind: 'release' as const };
    const radar = new OfflineRadar([commitSource, releaseSource]);
    radar.complete(radar.begin(commitSource.id, 0), { observations: [observation(commitSource)], nextCursor: 'one' }, 1);
    const candidate = radar.candidates()[0]!;
    radar.reject(candidate.id, 'Insufficient source evidence');
    candidate.status = 'DISCOVERED';
    radar.complete(radar.begin(releaseSource.id, 2), { observations: [{ ...observation(commitSource), referenceUrl: `${commitSource.repo}/releases/tag/v1.0` }], nextCursor: 'one' }, 3);
    expect(radar.candidates()).toHaveLength(1);
    expect(radar.candidates()[0]?.references).toHaveLength(2);
    expect(radar.candidates()[0]?.sourceIds).toHaveLength(2);
    expect(radar.candidates()[0]?.status).toBe('REJECTED');
    expect(radar.candidates()[0]?.rejectionReason).toBe('Insufficient source evidence');
  });

  it('bounds retry delays, preserves the last cursor on failure, and stops exhausted sources', () => {
    const radar = new OfflineRadar([sources()[0]!], { maxAttempts: 3, baseDelayMs: 10, maxCandidates: 20 });
    let request = radar.begin('source-0', 0);
    radar.fail(request, 'fetch-failed', 1);
    expect(() => radar.begin('source-0', 10)).toThrow(/retry/);
    request = radar.begin('source-0', 11);
    expect(request.cursor).toBeNull();
    radar.fail(request, 'fetch-failed', 12);
    request = radar.begin('source-0', 32);
    radar.fail(request, 'fetch-failed', 33);
    expect(() => radar.begin('source-0', 1_000)).toThrow(/exhausted/);
    expect(radar.status('source-0').attempts).toBe(3);
  });

  it('keeps license review, transfer conflict checks and revocation separate from source content', () => {
    const registry = new GeneRegistry({ allowedLicenses: ['MIT'], verifyEvidence: () => true });
    const registered = registry.register(gene());
    expect(registered.status).toBe('DISCOVERED');
    expect(() => registry.proposeTransfer(transfer())).toThrow(/eligible/);
    registry.review('gene-1', 1);
    const proposal = registry.proposeTransfer(transfer());
    expect(proposal.status).toBe('CANDIDATE');
    expect(proposal.countsAsAcceptedTransfer).toBe(false);
    expect(() => registry.proposeTransfer({ ...transfer(), id: 'transfer-2' })).toThrow(/conflict/);
    registry.revoke('gene-1', 'license-changed', 'review-2');
    expect(registry.transfers()[0]?.status).toBe('REVOKED');
    expect(() => registry.proposeTransfer({ ...transfer(), id: 'transfer-3' })).toThrow(/eligible/);
  });

  it('retains paired raw results and computes repeatable fixture-only bootstrap statistics', () => {
    const experiment = new OfflineExperiment(manifest());
    expect(experiment.inspectChanges(manifest().allowedPaths).allowed).toBe(true);
    experiment.record(pairs());
    const report = experiment.report();
    expect(report.n).toBe(100);
    expect(report.effectPercentagePoints).toBeCloseTo(20);
    expect(report.bootstrap95.lower).toBeGreaterThan(0);
    expect(report.baseline.successes).toBe(60);
    expect(report.candidate.successes).toBe(80);
    expect(report.rawRecords).toHaveLength(100);
    expect(report).toEqual(experiment.report());
    expect(report.claim.outcome).toBe('NOT_PROVEN');
    expect(report.claim.g8).toBe('NOT_VERIFIED');
    expect(report.fixtureRecommendation).toBe('CANDIDATE_FOR_HUMAN_REVIEW');
    report.rawRecords.length = 0;
    expect(experiment.report().n).toBe(100);
  });

  it('retains failed candidates and stops bounded search when its budget is reserved', () => {
    const search = new OfflineSearch({ maxCandidates: 5, budgetUnits: 5 });
    for (let index = 0; index < 5; index++) {
      const lease = search.reserve(`candidate-${index}`, 1);
      search.finish(lease, { outcome: index === 4 ? 'improved-fixture' : 'failed', evidenceRef: `report-${index}` });
    }
    expect(search.archive()).toHaveLength(5);
    expect(search.remainingBudgetUnits()).toBe(0);
    expect(() => search.reserve('candidate-6', 1)).toThrow(/limit|budget/);
  });

  it('prepares manual promotion and rollback metadata without modifying a stable instance', () => {
    const experiment = new OfflineExperiment(manifest());
    expect(experiment.inspectChanges(manifest().allowedPaths).allowed).toBe(true);
    experiment.record(pairs());
    const proposal = proposePromotion(experiment);
    expect(proposal.decision).toBe('REQUIRES_INDEPENDENT_REVIEW');
    expect(proposal.executable).toBe(false);
    const rollback = proposeRollback(proposal, 'security-incident');
    expect(rollback.restoreCommit).toBe(manifest().baselineCommit);
    expect(rollback.status).toBe('AWAITING_POLICY_APPROVAL');
    expect(rollback.executable).toBe(false);
  });
});
