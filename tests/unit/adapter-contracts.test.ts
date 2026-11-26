import { describe, expect, it } from 'vitest';
import { AgentEventStreamValidator, validateAgentCheckpoint, validateAgentRunEvent, validateAgentRunInput } from '../../packages/execution/src/index.ts';
import { FakeAdapter, REAL_ADAPTERS_IMPLEMENTED } from '../../packages/adapters/src/index.ts';
import type { AgentCheckpoint, AgentRunEvent } from '../../packages/execution/src/index.ts';
import { capsule, input } from './adapter-fixtures.ts';
async function collect(events: AsyncIterable<AgentRunEvent>): Promise<AgentRunEvent[]> { const output = []; for await (const event of events) output.push(event); return output; }
const signal = () => new AbortController().signal;
function status(sequence: number, state: 'running' | 'succeeded' | 'cancelled' = 'running'): AgentRunEvent { return { schemaVersion: 1, taskId: 'task-1', runId: 'run-1', sequence, occurredAt: new Date().toISOString(), type: 'status', status: state }; }
describe('strict offline adapter contracts', () => {
  it('accepts a minimal zero-cost input and verified capsule', () => { validateAgentRunInput(input()); const v = input(); v.capsule = capsule(); validateAgentRunInput(v); });
  it.each(['taskId','runId','purpose','scope','permissions','budget','cwd','trace','approvalRef','attempt','capsule','readOnlyRefs'])('rejects missing %s', key => { const v = { ...input() } as Record<string, unknown>; delete v[key]; expect(() => validateAgentRunInput(v)).toThrow(); });
  it.each([
    { token: 'opaque' }, { approvalRef: 'raw-secret' }, { cwd: '/repo/../private' }, { cwd: '/repo/./file' }, { cwd: '/repo\\private' }, { purpose: '' }, { attempt: 0 }, { attempt: 1.1 }, { attempt: NaN }, { attempt: 1001 }, { taskId: '../task' }, { schemaVersion: 2 },
  ])('rejects invalid boundary %j', patch => { expect(() => validateAgentRunInput({ ...input(), ...patch })).toThrow(); });
  it('rejects nested unknown fields and noncanonical clock', () => { const v = input(); expect(() => validateAgentRunInput({ ...v, permissions: { ...v.permissions, grant: true } })).toThrow(); expect(() => validateAgentRunInput(v, NaN)).toThrow(); });
  it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid budget %s', maxTokens => { const v = input(); v.budget.maxTokens = maxTokens; expect(() => validateAgentRunInput(v)).toThrow(); });
  it('rejects timeout zero/overflow, wildcard network and writable refs', () => { const v = input(); for (const timeoutMs of [0, 86400001]) expect(() => validateAgentRunInput({ ...v, budget: { ...v.budget, timeoutMs } })).toThrow(); v.permissions.networkDomains = ['*']; expect(() => validateAgentRunInput(v)).toThrow(); expect(() => validateAgentRunInput({ ...input(), readOnlyRefs: [{ ...capsule().references[0], readOnly: false }] })).toThrow(); });
  it('rejects cross-task scope and capsule scope', () => { const v = input(); v.scope.taskId = 'other'; expect(() => validateAgentRunInput(v)).toThrow(); const c = capsule(); c.scope.branch = 'other'; expect(() => validateAgentRunInput({ ...input(), capsule: c })).toThrow(); });
  it.each(['DONE','RUNNING','waiting_approval','failed'])('rejects unsupported status %s', state => { expect(() => validateAgentRunEvent({ ...status(1), status: state })).toThrow(); });
  it('checks event order, identity, terminal status and completeness', () => {
    const stream: AgentEventStreamValidator = new AgentEventStreamValidator('task-1', 'run-1');
    expect(() => stream.accept(status(2))).toThrow(); expect(() => stream.accept(status(1, 'succeeded'))).toThrow(); stream.accept(status(1));
    expect(() => stream.accept(status(2))).toThrow(); expect(() => stream.accept({ ...status(2, 'succeeded'), runId: 'other' })).toThrow(); expect(() => stream.finish()).toThrow();
    stream.accept(status(2, 'succeeded')); stream.finish(); expect(() => stream.accept(status(3, 'cancelled'))).toThrow();
  });
  it('validates checkpoint summary recovery, expiration and identity', () => {
    const now = Date.now(); const c = capsule(now); const checkpoint: AgentCheckpoint = { schemaVersion: 1, taskId: c.scope.taskId, runId: 'run-1', adapterId: 'fake-offline', scope: c.scope, createdAt: new Date(now).toISOString(), expiresAt: c.expiresAt, capsule: c, lastSequence: 2, recovery: 'new-session-with-summary' };
    validateAgentCheckpoint(checkpoint, now);
    for (const patch of [{ recovery: 'native' }, { runId: '' }, { taskId: 'other' }, { lastSequence: -1 }, { expiresAt: new Date(now).toISOString() }, { token: 'secret' }]) expect(() => validateAgentCheckpoint({ ...checkpoint, ...patch }, now)).toThrow();
  });
});
describe('FakeAdapter offline behavior', () => {
  it('streams validated output without native resume, tool calls, providers or spending', async () => {
    const adapter = new FakeAdapter(); expect(await adapter.capabilities()).toEqual({ streaming: true, resume: false, cancellation: true, toolCalls: false, contextHandoff: 'summary' }); expect('resume' in adapter).toBe(false); expect(REAL_ADAPTERS_IMPLEMENTED).toBe(false);
    const events = await collect(adapter.start(input(), signal())); expect(events.map(e => e.type)).toEqual(['status','output','output','status']); expect(events.at(-1)).toMatchObject({ status: 'succeeded' }); const validator: AgentEventStreamValidator = new AgentEventStreamValidator('task-1','run-1'); events.forEach(event => validator.accept(event)); validator.finish();
  });
  it('honors cancel(runId) after start and before consumption', async () => { const adapter = new FakeAdapter(); const stream = adapter.start(input(), signal()); await adapter.cancel('run-1'); expect(await collect(stream)).toEqual([expect.objectContaining({ status: 'cancelled', sequence: 1 })]); });
  it('bounds unconsumed reservations without attaching AbortSignal listeners', async () => { const adapter = new FakeAdapter(); const c = new AbortController(); for (let i = 0; i < 256; i++) adapter.start({ ...input(), runId: `run-${i}` }, c.signal); expect(() => adapter.start({ ...input(), runId: 'overflow' }, c.signal)).toThrow('Too many'); await adapter.cancel('run-0'); expect(() => adapter.start({ ...input(), runId: 'overflow' }, c.signal)).not.toThrow(); });
  it('releases more than 256 reservations returned before first next', async () => {
    const adapter = new FakeAdapter();
    for (let i = 0; i < 300; i++) {
      const iterator = adapter.start({ ...input(), runId: `closed-${i}` }, signal())[Symbol.asyncIterator]();
      expect(await iterator.return?.()).toEqual({ done: true, value: undefined });
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
    }
    expect((await collect(adapter.start(input(), signal()))).at(-1)).toMatchObject({ status: 'succeeded' });
  });
  it('releases more than 256 reservations thrown before first next', async () => {
    const adapter = new FakeAdapter(); const error = new Error('consumer closed');
    for (let i = 0; i < 300; i++) {
      const iterator = adapter.start({ ...input(), runId: `thrown-${i}` }, signal())[Symbol.asyncIterator]();
      await expect(iterator.throw?.(error)).rejects.toBe(error);
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
    }
    expect((await collect(adapter.start(input(), signal()))).at(-1)).toMatchObject({ status: 'succeeded' });
  });
  it.each(['return', 'throw'] as const)('closing with %s aborts pending delay without emitting more events', async method => {
    const adapter = new FakeAdapter({ delayMs: 5000 });
    const iterator = adapter.start(input(), signal())[Symbol.asyncIterator]();
    await iterator.next(); const pending = iterator.next(); const error = new Error('closed');
    const closing = method === 'return' ? iterator.return!() : iterator.throw!(error);
    const checkedClose = method === 'return' ? expect(closing).resolves.toMatchObject({ done: true }) : expect(closing).rejects.toBe(error);
    expect(await pending).toEqual({ done: true, value: undefined }); await checkedClose;
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });
  it('handles cancellation before starting', async () => { const c = new AbortController(); c.abort(); expect(await collect(new FakeAdapter().start(input(), c.signal))).toEqual([expect.objectContaining({ status: 'cancelled', sequence: 1 })]); });
  it('handles AbortSignal cancellation during delay promptly', async () => { const c = new AbortController(); const iterable = new FakeAdapter({ delayMs: 5000 }).start(input(), c.signal)[Symbol.asyncIterator](); await iterable.next(); const pending = iterable.next(); c.abort(); expect((await pending).value).toMatchObject({ status: 'cancelled' }); expect((await iterable.next()).done).toBe(true); });
  it('supports cancel(runId), including after last output', async () => { const adapter = new FakeAdapter({ chunks: ['one'] }); const iterator = adapter.start(input(), signal())[Symbol.asyncIterator](); await iterator.next(); await iterator.next(); await adapter.cancel('run-1'); expect((await iterator.next()).value).toMatchObject({ status: 'cancelled' }); await iterator.return?.(); await adapter.cancel('missing'); });
  it('times out an active wait', async () => { const v = input(); v.budget.timeoutMs = 10; const events = await collect(new FakeAdapter({ delayMs: 100 }).start(v, signal())); expect(events.at(-1)).toMatchObject({ type: 'failure', code: 'TIMEOUT', retryable: true }); expect(events.some(e => e.type === 'output')).toBe(false); });
  it('times out when consumer delays, including an empty stream', async () => { const v = input(); v.budget.timeoutMs = 1; const iterator = new FakeAdapter({ chunks: [] }).start(v, signal())[Symbol.asyncIterator](); await iterator.next(); await new Promise(r => setTimeout(r, 10)); expect((await iterator.next()).value).toMatchObject({ code: 'TIMEOUT' }); await iterator.return?.(); });
  it('reports missing context explicitly', async () => { const adapter = new FakeAdapter({ requireContext: true }); expect((await collect(adapter.start(input(), signal()))).at(-1)).toMatchObject({ code: 'CONTEXT_MISSING', retryable: false }); const v = input(); v.runId = 'run-2'; v.capsule = capsule(); expect((await collect(adapter.start(v, signal()))).at(-1)).toMatchObject({ status: 'succeeded' }); });
  it('retries only as an explicit new session, without hidden calls', async () => { const adapter = new FakeAdapter({ failAttempts: 1 }); const v = input(); expect((await collect(adapter.start(v, signal()))).at(-1)).toMatchObject({ code: 'ADAPTER_FAILURE' }); expect(() => adapter.start(v, signal())).toThrow('new runId'); v.runId = 'run-2'; v.attempt = 2; expect((await collect(adapter.start(v, signal()))).at(-1)).toMatchObject({ status: 'succeeded' }); });
  it('revalidates expiring context on deferred first consumption', async () => { const v = input(); v.capsule = capsule(); v.capsule.expiresAt = new Date(Date.now() + 10).toISOString(); const stream = new FakeAdapter().start(v, signal()); await new Promise(r => setTimeout(r, 20)); await expect(collect(stream)).rejects.toThrow('expired'); });
  it('snapshots inputs and rejects concurrent duplicate IDs', async () => { const adapter = new FakeAdapter(); const v = input(); const stream = adapter.start(v, signal()); v.runId = 'mutated'; const iterator = stream[Symbol.asyncIterator](); expect((await iterator.next()).value).toMatchObject({ runId: 'run-1' }); expect(() => adapter.start(input(), signal())).toThrow(); await iterator.return?.(); });
  it.each([{ delayMs: -1 }, { failAttempts: 0.5 }, { chunks: [''] }, { chunks: new Array(257).fill('a') }])('rejects invalid fake options %j', options => { expect(() => new FakeAdapter(options)).toThrow(); });
});
