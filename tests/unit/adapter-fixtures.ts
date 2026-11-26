import type { AgentRunInput, HandoffCapsule } from '../../packages/execution/src/index.ts';
export function capsule(now = Date.now()): HandoffCapsule {
  return { schemaVersion: 1, id: 'capsule-1', scope: { repo: 'owner/repo', branch: 'feature', taskId: 'task-1', sourceVersion: 'commit-1' }, goal: 'Offline contract test',
    facts: [{ id: 'fact-1', text: 'Test suite passed.', classification: 'verified', evidenceRefs: ['evidence-1'] }, { id: 'guess-1', text: 'Potential next step.', classification: 'inferred', evidenceRefs: [] }],
    references: [{ id: 'evidence-1', uri: 'artifact:test-log', sha256: 'a'.repeat(64), readOnly: true }], changedCommits: ['b'.repeat(40)], failedExperiments: [], openQuestions: [], nextSteps: ['Review'], confidentiality: 'internal', createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString(), acceptedBy: 'host-review' };
}
export function input(now = Date.now()): AgentRunInput {
  return { schemaVersion: 1, taskId: 'task-1', runId: 'run-1', purpose: 'Test offline adapter protocol', scope: capsule(now).scope, readOnlyRefs: [],
    permissions: { policyDecisionId: 'policy-1', commands: [], networkDomains: [], readPaths: ['/workspace/repo'], writePaths: [] }, budget: { id: 'budget-1', maxTokens: 0, maxCalls: 0, maxCostMicros: 0, timeoutMs: 1000 }, cwd: '/workspace/repo', capsule: null, trace: { traceId: 'trace-1', spanId: 'span-1' }, approvalRef: 'approval:one', attempt: 1 };
}
