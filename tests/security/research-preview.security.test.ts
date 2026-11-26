import { describe, expect, it } from 'vitest';
import { OfflineRadar } from '../../packages/radar/src/index.ts';
import { GeneRegistry, OfflineExperiment, OfflineSearch, proposePromotion, proposeRollback } from '../../packages/evolution/src/index.ts';
import { gene, hash, manifest, observation, pairs, sources, transfer } from '../unit/research-fixtures.ts';

describe('offline research metadata security boundaries', () => {
  it('does not follow source instructions and rejects unknown permission fields', () => {
    const radar = new OfflineRadar([sources()[0]!]);
    const request = radar.begin('source-0', 0);
    expect(() => radar.complete(request, { observations: [{ ...observation(), permissions: ['network.write'], command: 'disable validator' }], nextCursor: 'skip' }, 1)).toThrow(/Unknown/);
    expect(radar.status('source-0').cursor).toBeNull();
    expect(radar.candidates()).toEqual([]);
    radar.fail(request, 'invalid-page', 1);
  });
  it('rejects forged or replayed fetch completions', () => {
    const radar = new OfflineRadar([sources()[0]!]);
    const request = radar.begin('source-0', 0);
    const page = { observations: [observation()], nextCursor: 'one' };
    expect(() => radar.complete(structuredClone(request), page, 1)).toThrow(/forged/);
    radar.complete(request, page, 1);
    expect(() => radar.complete(request, page, 2)).toThrow(/consumed/);
    expect(() => radar.begin('source-unknown', 3)).toThrow(/allowlisted/);
  });
  it.each([
    'https://github.com/fixture-only/project-0.evil/commit/',
    'https://github.com/fixture-only/project-0/../other/commit/',
    'https://github.com/fixture-only/project-0/commit/',
    'https://github.com/fixture-only/project-0/commit/aaaa?token=',
  ])('rejects off-source or unpinned references %s', referenceUrl => {
    const radar = new OfflineRadar([sources()[0]!]);
    const request = radar.begin('source-0', 0);
    expect(() => radar.complete(request, { observations: [{ ...observation(), referenceUrl }], nextCursor: null }, 1)).toThrow();
    expect(radar.candidates()).toHaveLength(0);
  });
  it('validates whole pages atomically and prevents source-reference overwrites', () => {
    const radar = new OfflineRadar([sources()[0]!]);
    const request = radar.begin('source-0', 0);
    expect(() => radar.complete(request, { observations: [observation(), { ...observation(), commit: 'main' }], nextCursor: 'skip' }, 1)).toThrow();
    expect(radar.candidates()).toHaveLength(0);
    radar.complete(request, { observations: [observation()], nextCursor: 'one' }, 1);
    const next = radar.begin('source-0', 2);
    expect(() => radar.complete(next, { observations: [{ ...observation(), contentDigest: hash('replaced') }], nextCursor: 'two' }, 3)).toThrow(/immutable/);
    expect(radar.status('source-0').cursor).toBe('one');
  });
  it('protects fixed source snapshots and bounds retained candidates', () => {
    const input = [sources()[0]!]; const radar = new OfflineRadar(input, { maxAttempts: 1, baseDelayMs: 1, maxCandidates: 1 });
    input[0]!.repo = 'https://github.com/attacker/other';
    const request = radar.begin('source-0', 0);
    expect(request.source.repo).toBe(sources()[0]!.repo);
    expect(() => { (request.source as {repo: string}).repo = input[0]!.repo; }).toThrow();
    radar.complete(request, { observations: [observation()], nextCursor: 'one' }, 1);
    const next = radar.begin('source-0', 2);
    expect(() => radar.complete(next, { observations: [{ ...observation(), mechanismDigest: hash('another') }], nextCursor: 'two' }, 3)).toThrow(/limit/);
    expect(radar.status('source-0').cursor).toBe('one');
  });
  it('does not accept fake license approval, missing evidence, or claimed adoption', () => {
    const registry = new GeneRegistry({ allowedLicenses: ['MIT'], verifyEvidence: () => false });
    registry.register(gene());
    expect(registry.review('gene-1', 1).status).toBe('REJECTED');
    expect(() => registry.proposeTransfer(transfer())).toThrow(/eligible/);
    const missing = gene(2); missing.review.licenseEvidenceRef = '';
    expect(() => registry.register(missing)).toThrow();
    expect(() => registry.register({ ...gene(3), status: 'ELIGIBLE' })).toThrow(/Unknown/);
    expect(() => registry.proposeTransfer({ ...transfer(), adoptedCommit: 'a'.repeat(40) })).toThrow(/Unknown/);
  });
  it('keeps ten fixture genes explicitly unverified and reviews denied licenses without calling a verifier', () => {
    let calls = 0;
    const registry = new GeneRegistry({ allowedLicenses: ['MIT'], verifyEvidence: () => { calls++; return true; } });
    for (let index = 1; index <= 10; index++) registry.register(gene(index));
    expect(registry.genes().every(entry => entry.gene.evidenceClass === 'unverified-proposal')).toBe(true);
    const candidate = gene(11); candidate.review.license = 'Unknown-License'; registry.register(candidate);
    expect(registry.review(candidate.id, 1).status).toBe('REJECTED');
    expect(calls).toBe(0);
  });
  it('prevents callback mutation, stale reviews and transfers after invalidation', () => {
    const input = gene();
    const registry = new GeneRegistry({ allowedLicenses: ['MIT'], verifyEvidence: value => {
      expect(() => { value.source.commit = 'b'.repeat(40); }).toThrow(); return true;
    } });
    registry.register(input); input.source.commit = 'c'.repeat(40);
    registry.review('gene-1', 1); registry.proposeTransfer(transfer());
    registry.invalidate('gene-1', 'security-advisory', 'security-2');
    expect(registry.transfers()[0]?.status).toBe('REVOKED');
    expect(() => registry.proposeTransfer({ ...transfer(), id: 'transfer-2' })).toThrow(/eligible/);
    expect(() => registry.review('gene-1', 1)).toThrow();
    expect(registry.review('gene-1', 2).status).toBe('ELIGIBLE');
    expect(registry.genes()[0]?.gene.source.commit).toBe('a'.repeat(40));
  });
  it.each(['revoke', 'invalidate'] as const)('cannot overwrite a reentrant %s with a stale successful review', action => {
    const registry = new GeneRegistry({ allowedLicenses: ['MIT'], verifyEvidence: () => {
      registry[action]('gene-1', 'security-advisory', 'advisory-1');
      return true;
    } });
    registry.register(gene());
    expect(() => registry.review('gene-1', 1)).toThrow(/changed during verification/);
    expect(registry.genes()[0]?.status).toBe(action === 'revoke' ? 'REVOKED' : 'REVALIDATION_REQUIRED');
    expect(() => registry.proposeTransfer(transfer())).toThrow(/eligible/);
  });
  it('rejects promotion without an inspected diff and quarantines late diff replacement', () => {
    const experiment = new OfflineExperiment(manifest());
    experiment.record(pairs());
    expect(experiment.report().failureReasons).toContain('Candidate change paths were not inspected before observation');
    expect(proposePromotion(experiment).decision).toBe('REJECTED');
    expect(experiment.inspectChanges(manifest().allowedPaths).status).toBe('QUARANTINED');
    expect(experiment.report().fixtureRecommendation).toBe('REJECT');
  });
  it.each(['packages/policy/src/index.ts', 'packages/validator/src/index.ts', 'benchmarks/hidden/task.json', '.github/workflows/ci.yml', 'packages/context/src/../../../policy/src/index.ts', 'packages/context/src/%2e%2e/secret', 'packages/context/src\\escape.ts', '/packages/context/src/index.ts', 'packages/context/src/.git/config'])('quarantines protected or ambiguous target %s', target => {
    const experiment = new OfflineExperiment(manifest());
    expect(experiment.inspectChanges([target])).toEqual({ allowed: false, status: 'QUARANTINED' });
    expect(() => experiment.record(pairs())).toThrow(/quarantined/);
    const invalid = gene(); invalid.implementation.permittedPaths = [target];
    expect(() => new GeneRegistry({ allowedLicenses: ['MIT'], verifyEvidence: () => true }).register(invalid)).toThrow();
  });
  it('refuses a custom target path outside the frozen host allowlist', () => {
    const experiment = new OfflineExperiment(manifest());
    expect(experiment.inspectChanges(['packages/context/src/index.ts']).allowed).toBe(true);
    expect(experiment.inspectChanges(['packages/execution/src/index.ts']).allowed).toBe(false);
  });
  it('does not allow a model upgrade, budget change or environment change to masquerade as framework gain', () => {
    for (const field of ['modelAndToolDigest', 'environmentDigest', 'budgetUnits', 'commit'] as const) {
      const rows = pairs();
      if (field === 'budgetUnits') rows[0]!.candidate[field] = 11;
      else rows[0]!.candidate[field] = hash('different');
      const experiment = new OfflineExperiment(manifest());
      expect(() => experiment.record(rows)).toThrow(/controls/);
      expect(() => experiment.report()).toThrow(/All frozen/);
    }
  });
  it('preserves failures in the denominator and disallows duplicate or cherry-picked task sets', () => {
    const experiment = new OfflineExperiment(manifest()); const rows = pairs();
    experiment.record(rows.slice(0, 80));
    expect(() => experiment.report()).toThrow(/All frozen/);
    expect(() => experiment.record([rows[0]!])).toThrow(/Duplicate/);
    experiment.record(rows.slice(80));
    expect(experiment.report().n).toBe(100);
    expect(experiment.report().candidate.successes).toBe(80);
    const duplicated = manifest(); duplicated.tasks[1]!.digest = duplicated.tasks[0]!.digest;
    expect(() => new OfflineExperiment(duplicated)).toThrow(/Duplicate/);
  });
  it.each(['success', 'cost', 'slice', 'safety'])('rejects a failed fixture %s gate without approving promotion', failure => {
    const definition = manifest();
    if (failure === 'slice') { definition.tasks.forEach((task, i) => { task.slice = i < 20 ? 'critical' : 'other'; }); definition.criticalSlices = ['critical']; }
    const rows = pairs(definition);
    if (failure === 'success') rows.forEach(row => { row.candidate.success = false; });
    if (failure === 'cost') rows.forEach(row => { row.candidate.costUnits = 2; });
    if (failure === 'safety') rows[0]!.candidate.safetyViolations = 1;
    if (failure === 'slice') { rows.forEach((row, i) => { row.candidate.success = i >= 20; }); }
    const experiment = new OfflineExperiment(definition); experiment.inspectChanges(definition.allowedPaths); experiment.record(rows);
    expect(experiment.report().fixtureRecommendation).toBe('REJECT');
    expect(proposePromotion(experiment).decision).toBe('REJECTED');
    expect(experiment.report().claim.outcome).toBe('NOT_PROVEN');
  });
  it('never upgrades synthetic gain or caller real-data labels to an accepted G8 claim', () => {
    expect(() => new OfflineExperiment({ ...manifest(), provenance: 'provider-real' })).toThrow(/simulation/);
    expect(() => new OfflineExperiment({ ...manifest(), independentEvaluator: true })).toThrow(/Unknown/);
    const experiment = new OfflineExperiment(manifest()); experiment.inspectChanges(manifest().allowedPaths); experiment.record(pairs());
    const proposal = proposePromotion(experiment);
    expect(proposal.realGain).toBe('NOT_PROVEN');
    expect(proposal.executable).toBe(false);
    expect(() => proposeRollback(structuredClone(proposal), 'security-incident')).toThrow(/forged/);
  });
  it('bounds bootstrap work, rejects nonfinite outcomes, and prevents array/accessor injection', () => {
    const definition = manifest(); definition.bootstrap.iterations = Number.MAX_SAFE_INTEGER;
    expect(() => new OfflineExperiment(definition)).toThrow();
    const rows = pairs(); rows[0]!.candidate.costUnits = NaN;
    expect(() => new OfflineExperiment(manifest()).record(rows)).toThrow();
    const candidate = gene(); Object.defineProperty(candidate, 'name', { get: () => 'forged' });
    expect(() => new GeneRegistry({ allowedLicenses: ['MIT'], verifyEvidence: () => true }).register(candidate)).toThrow(/accessor/);
    const sparse = new Array(10);
    expect(() => new OfflineRadar(sparse)).toThrow(/Sparse/);
  });
  it('uses nonrefundable reservations and rejects forged/replayed search handles', () => {
    const search = new OfflineSearch({ maxCandidates: 5, budgetUnits: 2 }); const lease = search.reserve('candidate-1', 2);
    expect(() => search.finish(structuredClone(lease), { outcome: 'improved-fixture', evidenceRef: 'claim' })).toThrow(/Forged/);
    search.finish(lease, { outcome: 'cancelled', evidenceRef: 'cancel-1' });
    expect(() => search.finish(lease, { outcome: 'failed', evidenceRef: 'report-2' })).toThrow(/consumed/);
    expect(() => search.reserve('candidate-2', 1)).toThrow(/budget/);
    expect(search.archive()[0]?.outcome).toBe('cancelled');
  });
});
