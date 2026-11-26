import { array, ensure, id, integer, path, record, repo, sha, snapshot, text, unique } from '../../radar/src/boundary.ts';

export interface CapabilityGene {
  schemaVersion: 1; id: string; version: number; name: string;
  source: { repo: string; commit: string; evidence: Array<{ path: string; sha256: string }> };
  review: { license: string; licenseEvidenceRef: string; noticeEvidenceRef: string; sbomEvidenceRef: string; safetyEvidenceRef: string };
  capability: { problem: string; mechanism: string; applicability: string[]; preconditions: string[]; risks: string[] };
  implementation: { permittedPaths: string[] };
  validation: { suite: string; baselineCommit: string; metric: 'task_success_rate' };
  evidenceClass: 'unverified-proposal';
}
export interface GeneEntry {
  gene: CapabilityGene; status: 'DISCOVERED' | 'ELIGIBLE' | 'REJECTED' | 'REVALIDATION_REQUIRED' | 'REVOKED';
  reviewRevision: number; reason: string | null;
}
export interface TransferInput {
  id: string; geneId: string; geneVersion: number; targetRepo: string; baselineCommit: string;
  mechanismMappingRef: string; diffEvidenceRef: string; rollbackRef: string;
  changes: Array<{ path: string; beforeDigest: string; afterDigest: string }>;
}
export interface TransferProposal extends TransferInput {
  schemaVersion: 1; sourceRepo: string; sourceCommit: string; licenseEvidenceRef: string;
  status: 'CANDIDATE' | 'REVOKED'; countsAsAcceptedTransfer: false;
  adoptedCommit: null; independentValidationRunId: null;
}
const TARGET_ROOTS = ['packages/context/src/', 'packages/execution/src/', 'packages/adapters/src/', 'packages/fusion/src/'] as const;
/** Fixed offline proposal targets. Even trusted callers cannot use this preview to
 * admit changes to policy, evaluators, hidden tests, CI, the event store or runtime. */
export function validateExperimentPath(value: unknown): asserts value is string {
  path(value); ensure(TARGET_ROOTS.some(root => value.startsWith(root)), 'Protected or non-allowlisted experiment target');
}
export function validateGene(value: unknown): asserts value is CapabilityGene {
  record(value, ['schemaVersion', 'id', 'version', 'name', 'source', 'review', 'capability', 'implementation', 'validation', 'evidenceClass']);
  ensure(value.schemaVersion === 1 && value.evidenceClass === 'unverified-proposal', 'Only unverified version-1 gene proposals are supported');
  id(value.id); integer(value.version, 1, 1000); text(value.name);
  record(value.source, ['repo', 'commit', 'evidence']); repo(value.source.repo); sha(value.source.commit, 40);
  array(value.source.evidence, 1, 100);
  for (const item of value.source.evidence) { record(item, ['path', 'sha256']); path(item.path); sha(item.sha256, 64); }
  unique(value.source.evidence.map(item => (item as { path: string }).path));
  record(value.review, ['license', 'licenseEvidenceRef', 'noticeEvidenceRef', 'sbomEvidenceRef', 'safetyEvidenceRef']);
  for (const field of Object.values(value.review)) id(field);
  record(value.capability, ['problem', 'mechanism', 'applicability', 'preconditions', 'risks']);
  text(value.capability.problem, 4000); text(value.capability.mechanism, 8000);
  for (const field of ['applicability', 'preconditions', 'risks']) {
    const list = value.capability[field]; array(list, 1, 50); list.forEach(item => text(item, 500)); unique(list as string[]);
  }
  record(value.implementation, ['permittedPaths']); array(value.implementation.permittedPaths, 1, 100);
  value.implementation.permittedPaths.forEach(validateExperimentPath); unique(value.implementation.permittedPaths as string[]);
  record(value.validation, ['suite', 'baselineCommit', 'metric']); id(value.validation.suite); sha(value.validation.baselineCommit, 40);
  ensure(value.validation.metric === 'task_success_rate', 'Unsupported metric');
}
export interface GeneRegistryOptions {
  allowedLicenses: string[];
  /** Privileged host callback: resolve and verify actual pinned evidence bytes,
   * license/NOTICE/SBOM and safety decisions. An external "approved" label is not evidence. */
  verifyEvidence: (gene: Readonly<CapabilityGene>) => boolean;
}
/** In-memory proposal catalog, not an isolated source-research execution service.
 * No copy/install/adopt/promote operation exists. Version IDs cannot be overwritten. */
export class GeneRegistry {
  private readonly entries = new Map<string, GeneEntry>();
  private readonly proposals = new Map<string, TransferProposal>();
  private readonly allowedLicenses: readonly string[];
  private readonly verifyEvidence: GeneRegistryOptions['verifyEvidence'];
  constructor(options: GeneRegistryOptions) {
    record(options, ['allowedLicenses', 'verifyEvidence']); array(options.allowedLicenses, 1, 100);
    options.allowedLicenses.forEach(item => id(item)); unique(options.allowedLicenses);
    ensure(typeof options.verifyEvidence === 'function', 'Trusted evidence verifier required');
    this.allowedLicenses = snapshot(options.allowedLicenses); this.verifyEvidence = options.verifyEvidence;
  }
  register(value: unknown): GeneEntry {
    validateGene(value); ensure(this.entries.size < 1000, 'Gene catalog limit exceeded');
    ensure(!this.entries.has(value.id), 'Gene ID is immutable; a new version needs a new ID');
    const entry: GeneEntry = { gene: structuredClone(value), status: 'DISCOVERED', reviewRevision: 0, reason: null };
    this.entries.set(value.id, snapshot(entry)); return structuredClone(entry);
  }
  review(geneId: string, revision: number): GeneEntry {
    const entry = this.entries.get(geneId); ensure(entry, 'Unknown gene'); integer(revision, 1, 1000);
    ensure(['DISCOVERED', 'REVALIDATION_REQUIRED'].includes(entry.status) && revision > entry.reviewRevision, 'Gene review not permitted');
    const accepted = this.allowedLicenses.includes(entry.gene.review.license) && this.verifyEvidence(snapshot(entry.gene)) === true;
    ensure(this.entries.get(geneId) === entry, 'Gene changed during verification');
    const reviewed: GeneEntry = { ...entry, status: accepted ? 'ELIGIBLE' : 'REJECTED', reviewRevision: revision, reason: accepted ? null : 'License or provenance review failed' };
    this.entries.set(geneId, snapshot(reviewed)); return structuredClone(reviewed);
  }
  invalidate(geneId: string, reason: 'license-changed' | 'interface-changed' | 'security-advisory', evidenceRef: string): GeneEntry {
    return this.invalidateAs(geneId, reason, evidenceRef, 'REVALIDATION_REQUIRED');
  }
  revoke(geneId: string, reason: 'license-changed' | 'interface-changed' | 'security-advisory', evidenceRef: string): GeneEntry {
    return this.invalidateAs(geneId, reason, evidenceRef, 'REVOKED');
  }
  private invalidateAs(geneId: string, reason: string, evidenceRef: string, status: 'REVALIDATION_REQUIRED' | 'REVOKED'): GeneEntry {
    ensure(['license-changed', 'interface-changed', 'security-advisory'].includes(reason), 'Invalid invalidation reason'); id(evidenceRef);
    const entry = this.entries.get(geneId); ensure(entry && entry.status !== 'REVOKED', 'Unknown or revoked gene');
    const invalidated: GeneEntry = { ...entry, status, reason: `${reason}:${evidenceRef}` };
    this.entries.set(geneId, snapshot(invalidated));
    for (const [key, proposal] of this.proposals) if (proposal.geneId === geneId) this.proposals.set(key, snapshot({ ...proposal, status: 'REVOKED' }));
    return structuredClone(invalidated);
  }
  proposeTransfer(value: unknown): TransferProposal {
    record(value, ['id', 'geneId', 'geneVersion', 'targetRepo', 'baselineCommit', 'mechanismMappingRef', 'diffEvidenceRef', 'rollbackRef', 'changes']);
    id(value.id); id(value.geneId); integer(value.geneVersion, 1, 1000); repo(value.targetRepo); sha(value.baselineCommit, 40);
    id(value.mechanismMappingRef); id(value.diffEvidenceRef); id(value.rollbackRef); array(value.changes, 1, 100);
    const entry = this.entries.get(value.geneId);
    ensure(entry?.status === 'ELIGIBLE' && entry.gene.version === value.geneVersion, 'Gene is not eligible');
    ensure(value.baselineCommit === entry.gene.validation.baselineCommit, 'Transfer baseline mismatch');
    for (const change of value.changes) {
      record(change, ['path', 'beforeDigest', 'afterDigest']); validateExperimentPath(change.path); sha(change.beforeDigest, 64); sha(change.afterDigest, 64);
      ensure(change.beforeDigest !== change.afterDigest, 'Transfer must contain a real digest change');
      ensure(entry.gene.implementation.permittedPaths.includes(change.path), 'Path outside gene proposal scope');
      for (const prior of this.proposals.values()) ensure(prior.status !== 'CANDIDATE' || prior.targetRepo.toLowerCase() !== value.targetRepo.toLowerCase() || !prior.changes.some(item => item.path === change.path), 'Transfer path conflict');
    }
    unique(value.changes.map(item => (item as { path: string }).path));
    ensure(!this.proposals.has(value.id) && this.proposals.size < 1000, 'Duplicate transfer or archive limit');
    const proposal: TransferProposal = {
      ...structuredClone(value as unknown as TransferInput), schemaVersion: 1, sourceRepo: entry.gene.source.repo, sourceCommit: entry.gene.source.commit,
      licenseEvidenceRef: entry.gene.review.licenseEvidenceRef, status: 'CANDIDATE', countsAsAcceptedTransfer: false,
      adoptedCommit: null, independentValidationRunId: null,
    };
    this.proposals.set(proposal.id, snapshot(proposal)); return structuredClone(proposal);
  }
  genes(): GeneEntry[] { return structuredClone([...this.entries.values()]); }
  transfers(): TransferProposal[] { return structuredClone([...this.proposals.values()]); }
}
