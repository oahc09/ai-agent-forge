import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { EventStore } from '../../packages/event-store/src/index.ts';
import { HostAutoDevPreview } from '../../packages/autodev/src/index.ts';
import { FusionPreviewRouter } from '../../packages/fusion/src/index.ts';
import { previewCallbacks, previewConfig, previewMetadata, previewPlan } from '../unit/preview-fixtures.ts';
describe('durable host preview recovery', () => {
  it('recovers a process killed after claim, reconciles before retry, completes dependent task and replays', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'preview-kill-')); const db = join(dir, 'state.sqlite'); const now = Date.now();
    const config = previewConfig({ leaseMs: 1 }); let store: EventStore | undefined;
    try {
      const source = `import {EventStore} from ${JSON.stringify(resolve('packages/event-store/src/index.ts'))}; import {HostAutoDevPreview} from ${JSON.stringify(resolve('packages/autodev/src/index.ts'))}; const s=new EventStore(${JSON.stringify(db)},{clock:()=>new Date(${now})}); const p=new HostAutoDevPreview(s,${JSON.stringify(config)},()=>${now}); p.intake(${JSON.stringify(previewMetadata())},'',${JSON.stringify(previewPlan())}); p.claim(); process.kill(process.pid,'SIGKILL');`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }); expect(child.signal, child.stderr).toBe('SIGKILL');
      let clock = now + 2; store = new EventStore(db, { clock: () => new Date(clock) }); const preview = new HostAutoDevPreview(store, config, () => clock);
      expect(store.getTask('task-1')?.status).toBe('RUNNING'); expect(preview.claim()).toBeUndefined();
      preview.recoverExpired('task-1', { outcome: 'no-effects', evidenceRef: 'host:checked-no-callback-start' });
      preview.intake(previewMetadata('task-2'), '', previewPlan('task-2', { dependencies: ['task-1'] }));
      expect(await preview.drain(previewCallbacks())).toBe(2); expect(store.getTask('task-1')?.attempt).toBe(2); expect(store.listTasks().every(t => t.status === 'DONE')).toBe(true);
      clock++; expect(store.replay()).toEqual(store.listTasks()); const draft = preview.draft('task-1'); store.close(); store = new EventStore(db, { clock: () => new Date(clock) });
      const restarted = new HostAutoDevPreview(store, config, () => clock); expect(restarted.draft('task-1')).toEqual(draft); expect(await restarted.drain(previewCallbacks())).toBe(0);
    } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('quarantines expired callbacks with unknown effects, refusing silent retry', () => {
    let now = Date.now(); const store = new EventStore(':memory:', { clock: () => new Date(now) }); const preview = new HostAutoDevPreview(store, previewConfig({ leaseMs: 10 }), () => now);
    try { preview.intake(previewMetadata(), '', previewPlan()); preview.claim(); now += 11; preview.recoverExpired('task-1', { outcome: 'unknown', evidenceRef: 'host:unknown' }); expect(store.getTask('task-1')?.status).toBe('QUARANTINED'); expect(preview.claim()).toBeUndefined(); } finally { store.close(); }
  });
  it('fences stale completion and stale error handlers from a newer recovered run', async () => {
    let now = Date.now(); const store = new EventStore(':memory:', { clock: () => new Date(now) }); const config = previewConfig({ leaseMs: 100 }); const old = new HostAutoDevPreview(store, config, () => now); const fresh = new HostAutoDevPreview(store, config, () => now);
    try {
      old.intake(previewMetadata(), '', previewPlan()); const lease = old.claim()!; let resolve!: (value: Awaited<ReturnType<ReturnType<typeof previewCallbacks>['implement']>>) => void;
      const callbacks = previewCallbacks(); callbacks.implement = () => new Promise(r => { resolve = r; }); const pending = old.run(lease, callbacks); await Promise.resolve(); await Promise.resolve();
      now += 101; fresh.recoverExpired('task-1', { outcome: 'no-effects', evidenceRef: 'host:old-worker-stopped' }); const newer = fresh.claim()!;
      resolve(await previewCallbacks().implement({ plan: previewPlan(), attempt: 1, operationId: lease.runId, untrustedBodyRef: 'untrusted:test', signal: new AbortController().signal })); await pending;
      expect(store.getTask('task-1')).toMatchObject({ status: 'RUNNING', runId: newer.runId }); await fresh.run(newer, previewCallbacks()); expect(store.getTask('task-1')?.status).toBe('DONE');
    } finally { store.close(); }
  });
  it('persists routing decisions/budget and refuses configuration drift across restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fusion-restart-')); const db = join(dir, 'state.sqlite'); let store = new EventStore(db);
    const profiles = [{ adapter: { id: 'fake', capabilities: async () => ({ streaming: true, resume: false, cancellation: true, toolCalls: false, contextHandoff: 'summary' as const }), async *start() { throw new Error('not called'); }, cancel: async () => {} }, skills: ['code'], roles: ['coder' as const], independentScore: 70, evidenceRef: 'evidence:fixture', allowedRepos: ['owner/repo'] }];
    const request = { decisionId: 'd1', scope: { repo: 'owner/repo', branch: 'test', taskId: 'task-1', sourceVersion: 'v1' }, category: 'code', requiredSkills: ['code'], allowedAdapters: ['fake'], independentReview: false, budgetId: 'b1', maxInvocations: 1, policyDecisionId: 'p1', evidenceRefs: ['evidence:plan'], fallbackFrom: null, capsule: null };
    try { const first = new FusionPreviewRouter(store, profiles, () => true, Date.now, 1); const decision = await first.route(request); store.close(); store = new EventStore(db); const restarted = new FusionPreviewRouter(store, profiles, () => true, Date.now, 1); expect(await restarted.route(request)).toEqual(decision); await expect(restarted.route({ ...request, decisionId: 'd2', scope: { ...request.scope, taskId: 'task-2' } })).rejects.toThrow('Global'); expect(() => new FusionPreviewRouter(store, profiles, () => true, Date.now, 2)).toThrow('silently'); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
