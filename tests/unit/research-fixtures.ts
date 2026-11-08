import { createHash } from 'node:crypto';
import type { RadarObservation, RadarSource } from '../../packages/radar/src/index.ts';
import type { CapabilityGene, ExperimentManifest, PairedRecord, TransferInput } from '../../packages/evolution/src/index.ts';
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const BASELINE = 'a'.repeat(40);
export const CANDIDATE = 'b'.repeat(40);
/** Deliberately synthetic fixture sources, not claims of audited upstreams. */
export function sources(): RadarSource[] {
  return Array.from({length: 10}, (_, index) => ({ id: `source-${index}`, repo: `https://github.com/fixture-only/project-${index}`, kind: 'commit' }));
}
export function observation(source = sources()[0]!): RadarObservation {
  return { repo: source.repo, commit: BASELINE, mechanismDigest: hash(source.id), referenceUrl: `${source.repo}/commit/${BASELINE}`, contentDigest: hash('untrusted-source-text'), bodyRef: 'body-1' };
}
export function gene(index = 1): CapabilityGene {
  return {
    schemaVersion: 1, id: `gene-${index}`, version: 1, name: `fixture-handoff-${index}`,
    source: { repo: `https://github.com/fixture-only/project-${index}`, commit: BASELINE, evidence: [{ path: 'src/handoff.ts', sha256: hash(`source-${index}`) }] },
    review: { license: 'MIT', licenseEvidenceRef: 'license-1', noticeEvidenceRef: 'notice-1', sbomEvidenceRef: 'sbom-1', safetyEvidenceRef: 'security-1' },
    capability: { problem: 'Repeated investigation', mechanism: `Fixture mechanism ${index}`, applicability: ['coding'], preconditions: ['structured-task'], risks: ['context-loss'] },
    implementation: { permittedPaths: ['packages/context/src/index.ts'] },
    validation: { suite: 'fixture-context-v1', baselineCommit: BASELINE, metric: 'task_success_rate' }, evidenceClass: 'unverified-proposal',
  };
}
export function transfer(): TransferInput {
  return { id: 'transfer-1', geneId: 'gene-1', geneVersion: 1, targetRepo: 'https://github.com/fixture-only/forge', baselineCommit: BASELINE, mechanismMappingRef: 'mapping-1', diffEvidenceRef: 'diff-1', rollbackRef: 'rollback-1', changes: [{ path: 'packages/context/src/index.ts', beforeDigest: hash('before'), afterDigest: hash('after') }] };
}
export function manifest(): ExperimentManifest {
  return {
    schemaVersion: 1, experimentId: 'experiment-1', repo: 'https://github.com/fixture-only/forge', provenance: 'simulation',
    baselineCommit: BASELINE, candidateCommit: CANDIDATE, allowedPaths: ['packages/context/src/index.ts'],
    modelAndToolDigest: hash('model-and-tools'), environmentDigest: hash('simulation-env'), evaluatorDigest: hash('offline-fixture-statistics'), perTaskBudgetUnits: 10,
    tasks: Array.from({length: 100}, (_, index) => ({ id: `task-${index}`, digest: hash(`task-${index}`), slice: 'coding' })), criticalSlices: ['coding'], bootstrap: { seed: 7123, iterations: 2000 },
  };
}
export function pairs(definition = manifest()): PairedRecord[] {
  return definition.tasks.map((task, index) => ({
    taskId: task.id, taskDigest: task.digest, slice: task.slice,
    baseline: { commit: definition.baselineCommit, modelAndToolDigest: definition.modelAndToolDigest, environmentDigest: definition.environmentDigest, budgetUnits: definition.perTaskBudgetUnits, success: index < 60, costUnits: 1, latencyMs: 10, safetyViolations: 0 },
    candidate: { commit: definition.candidateCommit, modelAndToolDigest: definition.modelAndToolDigest, environmentDigest: definition.environmentDigest, budgetUnits: definition.perTaskBudgetUnits, success: index < 80, costUnits: 1, latencyMs: 15, safetyViolations: 0 },
  }));
}
