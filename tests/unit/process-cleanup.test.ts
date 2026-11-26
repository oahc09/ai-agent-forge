import { beforeEach, expect, it, vi } from 'vitest';
import { CodexFixtureProcessAdapter } from '../../packages/adapters/src/process-fixture-adapters.ts';
import { captureOfflineProcess } from '../../packages/adapters/src/offline-process.ts';
import type { ProcessObservation } from '../../packages/adapters/src/offline-process.ts';
import { input, capsule } from './adapter-fixtures.ts';

// Unit-only fault injection. No process is spawned by these tests; this is not
// real cleanup/isolation evidence. Integration tests separately spawn owned fixtures.
vi.mock('../../packages/adapters/src/offline-process.ts', () => ({ captureOfflineProcess: vi.fn() }));
beforeEach(() => { vi.mocked(captureOfflineProcess).mockReset(); });
const observation = (closed: boolean): ProcessObservation => ({ kind: 'offline-owned-fixture', format: 'codex', pid: null, exitCode: null, signal: null,
  reason: closed ? 'spawn-error' : 'cleanup-unconfirmed', closed, stdoutBytes: 0, stderrBytes: 0, runtimeVersion: process.version });
function reserve31(adapter: CodexFixtureProcessAdapter) {
  for (let n = 0; n < 31; n++) { const task = input(); task.runId = `pending-${n}`; adapter.start(task, new AbortController().signal); }
}
it('quarantines unknown cleanup and does not release its slot through cancel/return', async () => {
  vi.mocked(captureOfflineProcess).mockResolvedValue(observation(false));
  const adapter = new CodexFixtureProcessAdapter(); reserve31(adapter);
  const iterator = adapter.start(input(), new AbortController().signal)[Symbol.asyncIterator]();
  const events = [await iterator.next(), await iterator.next()];
  expect(events.at(-1)?.value).toMatchObject({ type: 'failure' });
  await iterator.return!(); await adapter.cancel('run-1');
  expect(adapter.observation('run-1')?.process.closed).toBe(false);
  const extra = input(); extra.runId = 'extra';
  expect(() => adapter.start(extra, new AbortController().signal)).toThrow();
  for (let n = 0; n < 31; n++) await adapter.cancel(`pending-${n}`);
});
it('releases capacity for confirmed no-process failure', async () => {
  vi.mocked(captureOfflineProcess).mockResolvedValue(observation(true));
  const adapter = new CodexFixtureProcessAdapter(); reserve31(adapter);
  for await (const event of adapter.start(input(), new AbortController().signal)) expect(event.type).not.toBe('output');
  const extra = input(); extra.runId = 'extra';
  expect(() => adapter.start(extra, new AbortController().signal)).not.toThrow();
  await adapter.cancel('extra');
  for (let n = 0; n < 31; n++) await adapter.cancel(`pending-${n}`);
});
it('cleans reservation when a deferred capsule expires before the first next', async () => {
  const now = Date.now();
  const adapter = new CodexFixtureProcessAdapter(); reserve31(adapter);
  const task = input(now); task.capsule = capsule(now); task.capsule.expiresAt = new Date(now + 1).toISOString();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const iterator = adapter.start(task, new AbortController().signal)[Symbol.asyncIterator]();
    clock.mockReturnValue(now + 2);
    await expect(iterator.next()).rejects.toThrow();
    expect(captureOfflineProcess).not.toHaveBeenCalled();
    const extra = input(now + 2); extra.runId = 'extra';
    expect(() => adapter.start(extra, new AbortController().signal)).not.toThrow();
    await adapter.cancel('extra');
    for (let n = 0; n < 31; n++) await adapter.cancel(`pending-${n}`);
  } finally { clock.mockRestore(); }
});
