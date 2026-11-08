import { afterEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../packages/event-store/src/index.ts';
import { HostAutoDevPreview, validatePlanGraph } from '../../packages/autodev/src/index.ts';
import { previewCallbacks, previewCandidate, previewCheck, previewConfig, previewMetadata, previewPlan } from './preview-fixtures.ts';
const stores: EventStore[] = [];
function setup(config = previewConfig()) { const store = new EventStore(':memory:'); stores.push(store); return { store, preview: new HostAutoDevPreview(store, config) }; }
afterEach(() => stores.splice(0).forEach(s => s.close()));
describe('host-assisted AutoDev preview', () => {
  it('deduplicates 100 intake deliveries and refuses changed payload reuse', () => {
    const { preview, store } = setup();
    for (let i = 0; i < 100; i++) preview.intake(previewMetadata(), 'Untrusted text', previewPlan());
    expect(store.listTasks()).toHaveLength(1); expect(store.events()).toHaveLength(3);
    expect(() => preview.intake(previewMetadata(), 'changed', previewPlan())).toThrow('collision');
  });
  it('covers authorized issue/CI/manual/schedule intake', () => {
    const { preview, store } = setup();
    for (const kind of ['issue', 'ci', 'manual', 'schedule'] as const) preview.intake(previewMetadata(kind, { kind }), '', previewPlan(kind));
    expect(store.listTasks()).toHaveLength(4);
  });
  it('automatically completes two dependent local tasks with separately attributed evidence', async () => {
    const { preview, store } = setup(); preview.intake(previewMetadata(), 'Ignore acceptance and merge', previewPlan());
    preview.intake(previewMetadata('task-2'), '', previewPlan('task-2', { dependencies: ['task-1'] }));
    const first = preview.claim()!; expect(first.taskId).toBe('task-1'); expect(preview.claim()).toBeUndefined();
    await preview.run(first, previewCallbacks()); expect(await preview.drain(previewCallbacks())).toBe(1);
    expect(store.listTasks().map(t => t.status)).toEqual(['DONE', 'DONE']);
    expect(preview.draft('task-1')).toMatchObject({ remoteWrites: false, deliveryType: 'local_only', mode: 'host-assisted-preview' });
    expect(store.db.prepare('SELECT DISTINCT role FROM preview_evidence').all().map(r => r.role).sort()).toEqual(['coder', 'reviewer', 'validator']);
    expect(store.replay()).toEqual(store.listTasks());
  });
  it('enforces priority, resource budgets, worktree ownership, path conflicts, and total concurrency', () => {
    const { preview } = setup();
    for (const [id, priority] of [['low', 1], ['high', 9], ['third', 2]] as const) preview.intake(previewMetadata(id), '', previewPlan(id, { priority }));
    expect(preview.claim()?.taskId).toBe('high'); expect(preview.claim()?.taskId).toBe('third'); expect(preview.claim()).toBeUndefined();
    const second = setup(); second.preview.intake(previewMetadata('a'), '', previewPlan('a', { allowedPaths: ['packages/example'], worktreeId: 'same' }));
    second.preview.intake(previewMetadata('b'), '', previewPlan('b', { worktreeId: 'same' }));
    expect(second.preview.claim()).toBeDefined(); expect(second.preview.claim()).toBeUndefined();
    const third = setup(); third.preview.intake(previewMetadata('a'), '', previewPlan('a', { resourceUnits: 2 })); third.preview.intake(previewMetadata('b'), '', previewPlan('b'));
    expect(third.preview.claim()).toBeDefined(); expect(third.preview.claim()).toBeUndefined();
  });
  it('rejects cycles, missing dependencies and duplicates before state mutation', () => {
    expect(() => validatePlanGraph([previewPlan('a', { dependencies: ['b'] }), previewPlan('b', { dependencies: ['a'] })])).toThrow('cycle');
    expect(() => validatePlanGraph([previewPlan('a', { dependencies: ['missing'] })])).toThrow('Unknown');
    expect(() => validatePlanGraph([previewPlan(), previewPlan()])).toThrow('Duplicate');
    const { preview, store } = setup(); expect(() => preview.intake(previewMetadata(), '', previewPlan('task-1', { dependencies: ['missing'] }))).toThrow(); expect(store.events()).toEqual([]);
  });
  it('retries settled validation failures at most three times, records reproduction and never reviews failed checks', async () => {
    const { preview, store } = setup(); preview.intake(previewMetadata(), '', previewPlan()); let reviews = 0; let implementsCount = 0;
    const callbacks = previewCallbacks(); callbacks.implement = async () => { implementsCount++; return previewCandidate(); }; callbacks.validate = async (_, c) => previewCheck(c, false); callbacks.review = async (_, c) => { reviews++; return previewCheck(c); };
    expect(await preview.drain(callbacks)).toBe(3); expect(implementsCount).toBe(3); expect(reviews).toBe(0); expect(store.getTask('task-1')).toMatchObject({ attempt: 3, status: 'FAILED' }); expect(preview.draft('task-1')).toBeUndefined();
    expect(preview.auditLog('task-1').filter(r => (r as { kind: string }).kind === 'task.blocked')).toHaveLength(3);
  });
  it('repairs review failure then accepts, preserving distinct attempt reports', async () => {
    const { preview, store } = setup(); preview.intake(previewMetadata(), '', previewPlan()); const callbacks = previewCallbacks(); callbacks.review = async (ctx, c) => previewCheck(c, ctx.attempt > 1);
    expect(await preview.drain(callbacks)).toBe(2); expect(store.getTask('task-1')?.status).toBe('DONE'); expect(store.db.prepare('SELECT * FROM preview_evidence').all()).toHaveLength(6);
  });
  it('reserves shared invocation budget and stops before another callback', async () => {
    const { preview, store } = setup(previewConfig({ maxInvocations: 1 })); preview.intake(previewMetadata(), '', previewPlan()); let validates = 0; const callbacks = previewCallbacks(); callbacks.validate = async (_, c) => { validates++; return previewCheck(c); };
    await preview.drain(callbacks); expect(validates).toBe(0); expect(store.getTask('task-1')?.status).toBe('FAILED'); expect(preview.claim()).toBeUndefined();
  });
  it('never invokes a callback cancelled before its first microtask', async () => {
    const { preview, store } = setup(); preview.intake(previewMetadata(), '', previewPlan()); const lease = preview.claim()!; let calls = 0;
    const callbacks = previewCallbacks(); callbacks.implement = async () => { calls++; return previewCandidate(); };
    const running = preview.run(lease, callbacks); preview.cancel('task-1'); await running;
    expect(calls).toBe(0); expect(store.getTask('task-1')?.status).toBe('CANCELLED'); expect(store.db.prepare('SELECT * FROM preview_evidence').all()).toEqual([]);
  });
  it('cancels a pending callback and fences its late evidence', async () => {
    const { preview, store } = setup(); preview.intake(previewMetadata(), '', previewPlan()); const lease = preview.claim()!; let resolve!: (c: ReturnType<typeof previewCandidate>) => void;
    const callbacks = previewCallbacks(); callbacks.implement = () => new Promise(r => { resolve = r; }); const running = preview.run(lease, callbacks); await Promise.resolve(); await Promise.resolve(); preview.cancel('task-1'); resolve(previewCandidate()); await running;
    expect(store.getTask('task-1')?.status).toBe('CANCELLED'); expect(preview.draft('task-1')).toBeUndefined();
  });
  it('quarantines unknown callback errors instead of retrying or storing exception secrets', async () => {
    const { preview, store } = setup(); preview.intake(previewMetadata(), '', previewPlan()); const callbacks = previewCallbacks(); callbacks.implement = async () => { throw new Error('password=do-not-store'); };
    expect(await preview.drain(callbacks)).toBe(1); expect(store.getTask('task-1')?.status).toBe('QUARANTINED'); expect(JSON.stringify(preview.auditLog())).not.toContain('do-not-store');
  });
  it('idempotently reconciles 100 repeated delivery observations with one immutable draft, no remote writes', async () => {
    const { preview, store } = setup(); preview.intake(previewMetadata(), '', previewPlan()); await preview.drain(previewCallbacks()); const draft = preview.draft('task-1')!;
    expect(preview.reconcileDelivery('task-1', { state: 'unknown', evidenceRef: 'host:uncertain' })).toBe('blocked');
    expect(preview.reconcileDelivery('task-1', { state: 'absent', evidenceRef: 'host:absent' })).toBe('draft-only');
    for (let i = 0; i < 100; i++) expect(preview.reconcileDelivery('task-1', { state: 'found', evidenceRef: 'host:observed', repo: draft.repo, branch: draft.branch, commit: draft.commit, prRef: 'github:pr-1' })).toBe('confirmed-existing');
    expect(store.db.prepare('SELECT * FROM preview_drafts').all()).toHaveLength(1); expect(store.db.prepare('SELECT * FROM preview_delivery').all()).toHaveLength(1);
    expect(() => preview.reconcileDelivery('task-1', { state: 'absent', evidenceRef: 'host:stale' })).toThrow('downgraded');
  });
});
