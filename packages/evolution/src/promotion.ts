import { digest, ensure, snapshot } from '../../radar/src/boundary.ts';
import { OfflineExperiment } from './benchmark.ts';
export interface PromotionProposal {
  schemaVersion: 1; experimentId: string; baselineCommit: string; candidateCommit: string;
  reportDigest: string; decision: 'REQUIRES_INDEPENDENT_REVIEW' | 'REJECTED';
  executable: false; realGain: 'NOT_PROVEN'; requiredApprovals: string[];
}
const issuedProposals = new WeakSet<PromotionProposal>();
/** Proposal only. No approval token, source annotation or boolean can make it an
 * executable grant. Real promotion belongs to a separately authorized host. */
export function proposePromotion(experiment: OfflineExperiment): PromotionProposal {
  ensure(experiment instanceof OfflineExperiment, 'Offline experiment required');
  const report = experiment.report(); const manifest = experiment.definition();
  const proposal: PromotionProposal = snapshot({
    schemaVersion: 1, experimentId: manifest.experimentId, baselineCommit: manifest.baselineCommit, candidateCommit: manifest.candidateCommit,
    reportDigest: digest(report), decision: report.fixtureRecommendation === 'REJECT' ? 'REJECTED' : 'REQUIRES_INDEPENDENT_REVIEW',
    executable: false, realGain: 'NOT_PROVEN', requiredApprovals: ['independent-evaluation', 'security-review', 'policy-approval', 'rollback-drill'],
  });
  issuedProposals.add(proposal); return proposal;
}
export function proposeRollback(proposal: PromotionProposal, reason: 'security-incident' | 'performance-regression' | 'license-revoked'): {
  schemaVersion: 1; experimentId: string; restoreCommit: string; candidateCommit: string; reason: string;
  status: 'AWAITING_POLICY_APPROVAL'; executable: false;
} {
  ensure(issuedProposals.has(proposal), 'Unknown or forged promotion proposal');
  ensure(proposal.decision !== 'REJECTED', 'Rejected candidate has no promotion plan to roll back');
  ensure(['security-incident', 'performance-regression', 'license-revoked'].includes(reason), 'Unsupported rollback reason');
  return snapshot({ schemaVersion: 1, experimentId: proposal.experimentId, restoreCommit: proposal.baselineCommit, candidateCommit: proposal.candidateCommit, reason, status: 'AWAITING_POLICY_APPROVAL', executable: false });
}
