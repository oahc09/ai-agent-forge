import { AdapterContractError, AgentEventStreamValidator, validateAgentRunInput, validateAgentRunEvent } from '../../execution/src/index.ts';
import type { AgentAdapter, AgentRunEvent, AgentRunInput } from '../../execution/src/index.ts';
export interface FakeAdapterOptions {
  chunks?: string[]; delayMs?: number; failAttempts?: number; requireContext?: boolean;
}
/** Deterministic protocol exerciser ONLY. Never imports a process/network tool,
 * reads files, invokes a model, spends budget, or executes declared permissions. */
export class FakeAdapter implements AgentAdapter {
  readonly id = 'fake-offline';
  private readonly chunks: string[];
  private readonly delayMs: number;
  private readonly failAttempts: number;
  private readonly requireContext: boolean;
  private readonly active = new Map<string, AbortController>();
  private readonly usedRunIds = new Set<string>();
  constructor(options: FakeAdapterOptions = {}) {
    if (Object.keys(options).some(key => !['chunks','delayMs','failAttempts','requireContext'].includes(key))) throw new AdapterContractError('Unknown fake option');
    this.chunks = structuredClone(options.chunks ?? ['offline ', 'result']);
    this.delayMs = options.delayMs ?? 0; this.failAttempts = options.failAttempts ?? 0; this.requireContext = options.requireContext ?? false;
    if (!Number.isSafeInteger(this.delayMs) || this.delayMs < 0 || this.delayMs > 86400000 || !Number.isSafeInteger(this.failAttempts) || this.failAttempts < 0 || this.failAttempts > 999 || typeof this.requireContext !== 'boolean' || !Array.isArray(this.chunks) || this.chunks.length > 256) throw new AdapterContractError('Invalid fake options');
    for (const text of this.chunks) validateAgentRunEvent({ schemaVersion: 1, taskId: 'test', runId: 'test', sequence: 1, occurredAt: '2026-01-01T00:00:00.000Z', type: 'output', text });
  }
  async capabilities() { return { streaming: true, resume: false, cancellation: true, toolCalls: false, contextHandoff: 'summary' as const }; }
  async cancel(runId: string): Promise<void> { this.active.get(runId)?.abort(); this.active.delete(runId); }
  start(input: AgentRunInput, signal: AbortSignal): AsyncIterable<AgentRunEvent> {
    validateAgentRunInput(input);
    if (!(signal instanceof AbortSignal)) throw new AdapterContractError('AbortSignal required');
    // Reserve cancellation state without attaching listeners to an unconsumed iterator.
    if (this.usedRunIds.has(input.runId)) throw new AdapterContractError('Retry requires a new runId/session');
    if (this.active.size >= 256) throw new AdapterContractError('Too many pending/active fake runs');
    this.usedRunIds.add(input.runId);
    const control = new AbortController(); this.active.set(input.runId, control);
    const snapshot = structuredClone(input);
    const generator = this.run(snapshot, signal, control);
    let closed = false;
    const close = () => { closed = true; control.abort(); this.active.delete(snapshot.runId); };
    const done = (): IteratorResult<AgentRunEvent, void> => ({ done: true, value: undefined });
    // Async generator finally does not run when return/throw precedes its first next.
    // Own the reservation outside the generator and suppress any pending yield on close.
    const iterator: AsyncIterableIterator<AgentRunEvent> = {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (closed) return done();
        const result = await generator.next();
        if (closed) return done();
        if (result.done) close();
        return result;
      },
      async return() { close(); await generator.return(); return done(); },
      async throw(error?: unknown) { close(); return generator.throw(error); },
    };
    return iterator;
  }
  private async *run(input: AgentRunInput, signal: AbortSignal, control: AbortController): AsyncGenerator<AgentRunEvent, void, unknown> {
    // Recheck expiry at first use after a deferred iterator pull, cleaning reserved state.
    try { validateAgentRunInput(input); } catch (error) { this.active.delete(input.runId); throw error; }
    const relay = () => control.abort(); signal.addEventListener('abort', relay, { once: true });
    if (signal.aborted) control.abort();
    let sequence = 0;
    const validator: AgentEventStreamValidator = new AgentEventStreamValidator(input.taskId, input.runId);
    const deadline = performance.now() + input.budget.timeoutMs;
    type Body = { type: 'status'; status: 'running' | 'succeeded' | 'cancelled' } | { type: 'output'; text: string } | { type: 'failure'; status: 'failed'; code: 'TIMEOUT' | 'ADAPTER_FAILURE' | 'CONTEXT_MISSING'; retryable: boolean };
    const emit = (body: Body): AgentRunEvent => {
      const event: AgentRunEvent = { schemaVersion: 1, taskId: input.taskId, runId: input.runId, sequence: ++sequence, occurredAt: new Date().toISOString(), ...body };
      validator.accept(event); return event;
    };
    const cancelled = (): AgentRunEvent => emit({ type: 'status', status: 'cancelled' });
    const timeout = (): AgentRunEvent => emit({ type: 'failure', status: 'failed', code: 'TIMEOUT', retryable: true });
    try {
      if (control.signal.aborted) { yield cancelled(); return; }
      yield emit({ type: 'status', status: 'running' });
      if (control.signal.aborted) { yield cancelled(); return; }
      if (performance.now() >= deadline) { yield timeout(); return; }
      if (this.requireContext && input.capsule === null) { yield emit({ type: 'failure', status: 'failed', code: 'CONTEXT_MISSING', retryable: false }); return; }
      if (input.attempt <= this.failAttempts) { yield emit({ type: 'failure', status: 'failed', code: 'ADAPTER_FAILURE', retryable: true }); return; }
      for (const text of this.chunks) {
        const readyAt = Math.min(deadline, performance.now() + this.delayMs);
        // Timers may fire slightly early; do not emit a chunk before its delay or deadline.
        while (!control.signal.aborted && performance.now() < readyAt) await pause(readyAt - performance.now(), control.signal);
        if (control.signal.aborted) { yield cancelled(); return; }
        if (performance.now() >= deadline) { yield timeout(); return; }
        yield emit({ type: 'output', text });
      }
      if (control.signal.aborted) yield cancelled();
      else if (performance.now() >= deadline) yield timeout();
      else yield emit({ type: 'status', status: 'succeeded' });
      validator.finish();
    } finally { signal.removeEventListener('abort', relay); this.active.delete(input.runId); }
  }
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, Math.ceil(ms)); signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}
export const REAL_ADAPTERS_IMPLEMENTED = false as const;
export { CodexJsonlDecoder } from './codex-jsonl.ts';
export { OpenCodeJsonlDecoder } from './opencode-jsonl.ts';
export type { ReportedUsage } from './jsonl-protocol.ts';
export { CodexFixtureProcessAdapter, OpenCodeFixtureProcessAdapter } from './process-fixture-adapters.ts';
export type { OfflineRunObservation } from './process-fixture-adapters.ts';
