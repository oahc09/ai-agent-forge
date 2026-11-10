import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { CodexFixtureProcessAdapter, OpenCodeFixtureProcessAdapter } from '../../packages/adapters/src/index.ts';
import type { AgentRunEvent } from '../../packages/execution/src/index.ts';
import { AgentEventStreamValidator } from '../../packages/execution/src/index.ts';
import { input } from '../unit/adapter-fixtures.ts';
import { captureOfflineProcess } from '../../packages/adapters/src/offline-process.ts';

async function collect(stream: AsyncIterable<AgentRunEvent>) {
  const events: AgentRunEvent[] = [];
  for await (const event of stream) events.push(event);
  const validator: AgentEventStreamValidator = new AgentEventStreamValidator('task-1', 'run-1');
  for (const event of events) validator.accept(event);
  validator.finish();
  return events;
}
const constructors = [CodexFixtureProcessAdapter, OpenCodeFixtureProcessAdapter];
for (const Adapter of constructors) describe(Adapter.name, () => {
  it('launches the real fixed child, frames split UTF-8/CRLF/trailing JSON, and reaps before success', async () => {
    const adapter = new Adapter();
    const events = await collect(adapter.start(input(), new AbortController().signal));
    expect(events).toMatchObject([{ status: 'running' }, { type: 'output', text: 'Offline transport 完成' }, { status: 'succeeded' }]);
    const record = adapter.observation('run-1')!;
    expect(record).toMatchObject({ realProvider: false, isolationVerified: false, process: { closed: true, exitCode: 0, reason: 'exited' } });
    expect(record.process.pid).toBeGreaterThan(0);
    expect(() => process.kill(record.process.pid!, 0)).toThrow();
    record.process.closed = false;
    expect(adapter.observation('run-1')?.process.closed).toBe(true);
    expect(await adapter.capabilities()).toMatchObject({ streaming: false, resume: false, toolCalls: false, contextHandoff: 'none' });
    expect(() => adapter.start(input(), new AbortController().signal)).toThrow();
  });
  it.each(['malformed', 'oversized', 'stderr-flood', 'invalid-utf8', 'failure'] as const)('fails closed for %s without exposing stderr', async scenario => {
    const adapter = new Adapter(scenario);
    const events = await collect(adapter.start(input(), new AbortController().signal));
    expect(events.at(-1)).toMatchObject({ type: 'failure', code: 'ADAPTER_FAILURE' });
    expect(events.some(event => event.type === 'output')).toBe(false);
    expect(adapter.observation('run-1')?.process.closed).toBe(true);
    expect(JSON.stringify({ events, observation: adapter.observation('run-1') })).not.toContain('private-error');
  });
  it.each(['hang', 'ignore-term', 'completed-hang'] as const)('times out and reaps %s, never mistakes protocol completion for process completion', async scenario => {
    const adapter = new Adapter(scenario); const task = input(); task.budget.timeoutMs = 350;
    const events = await collect(adapter.start(task, new AbortController().signal));
    expect(events.at(-1)).toMatchObject({ type: 'failure', code: 'TIMEOUT' });
    const processInfo = adapter.observation('run-1')!.process;
    expect(processInfo.closed).toBe(true);
    expect(processInfo.reason).toBe('timeout');
    if (scenario === 'completed-hang') expect(adapter.observation('run-1')!.usage).toHaveLength(1);
    expect(() => process.kill(processInfo.pid!, 0)).toThrow();
  });
  it('cancels an active child and cancel resolves only after reaping', async () => {
    const adapter = new Adapter('hang');
    const stream = adapter.start(input(), new AbortController().signal);
    const result = collect(stream);
    await new Promise(resolve => setTimeout(resolve, 50));
    await adapter.cancel('run-1');
    expect((await result).at(-1)).toMatchObject({ status: 'cancelled' });
    const processInfo = adapter.observation('run-1')!.process;
    expect(processInfo.closed).toBe(true);
    expect(() => process.kill(processInfo.pid!, 0)).toThrow();
  });
  it('pre-cancelled and pre-closed iterators never launch a process', async () => {
    const adapter = new Adapter();
    const stream = adapter.start(input(), new AbortController().signal);
    await adapter.cancel('run-1');
    expect((await collect(stream)).at(-1)).toMatchObject({ status: 'cancelled' });
    expect(adapter.observation('run-1')!.process.pid).toBeNull();
    const task = input(); task.runId = 'run-2';
    const iterator = adapter.start(task, new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.return!();
    expect((await iterator.next()).done).toBe(true);
    expect(adapter.observation('run-2')).toBeNull();
  });
  it('iterator close during a pending next aborts and suppresses pending delivery', async () => {
    const adapter = new Adapter('hang');
    const iterator = adapter.start(input(), new AbortController().signal)[Symbol.asyncIterator]();
    const next = iterator.next();
    const close = iterator.return!();
    expect((await next).done).toBe(true);
    expect((await close).done).toBe(true);
    expect(adapter.observation('run-1')?.process.closed).toBe(true);
  });
  it('caller cancellation works and cannot be hidden by input mutation', async () => {
    const adapter = new Adapter('hang'); const control = new AbortController(); const task = input();
    const stream = adapter.start(task, control.signal);
    task.runId = 'injected'; task.budget.timeoutMs = 1;
    const result = collect(stream); control.abort();
    expect((await result).at(-1)).toMatchObject({ runId: 'run-1', status: 'cancelled' });
  });
  it('rejects real budget, command, network, write and excessive-timeout declarations', () => {
    for (const mutate of [
      (task: ReturnType<typeof input>) => task.budget.maxCalls = 1,
      (task: ReturnType<typeof input>) => task.budget.maxCostMicros = 1,
      (task: ReturnType<typeof input>) => task.budget.maxTokens = 1,
      (task: ReturnType<typeof input>) => task.budget.timeoutMs = 5001,
      (task: ReturnType<typeof input>) => task.permissions.writePaths.push('/tmp'),
      (task: ReturnType<typeof input>) => task.permissions.networkDomains.push('example.com'),
      (task: ReturnType<typeof input>) => task.permissions.commands.push({ executable: 'sh', args: [] }),
    ]) {
      const task = input(); mutate(task);
      expect(() => new Adapter().start(task, new AbortController().signal)).toThrow();
    }
  });
});
it('does not inherit Node options, credentials, HOME or PATH into the fixed worker', async () => {
  const before = process.env.FORGE_TEST_SECRET;
  process.env.FORGE_TEST_SECRET = 'test-only-do-not-inherit';
  try {
    const adapter = new CodexFixtureProcessAdapter('env-check');
    const events = await collect(adapter.start(input(), new AbortController().signal));
    expect(events.find(event => event.type === 'output')).toMatchObject({ text: JSON.stringify({ inheritedSecret: false, nodeOptions: false, home: false, path: false }) });
  } finally { if (before === undefined) delete process.env.FORGE_TEST_SECRET; else process.env.FORGE_TEST_SECRET = before; }
});
it('rejects attacker-selected executable/scenario and invalid time limits before launch', () => {
  expect(() => captureOfflineProcess('sh' as 'codex', 'success', 1000, new AbortController().signal, () => {})).toThrow();
  expect(() => captureOfflineProcess('codex', '--eval' as 'success', 1000, new AbortController().signal, () => {})).toThrow();
  for (const timeout of [0, -1, Infinity, 5001]) expect(() => captureOfflineProcess('codex', 'success', timeout, new AbortController().signal, () => {})).toThrow();
});
it('poisons processing when the trusted decoder callback throws without leaking the error', async () => {
  const observation = await captureOfflineProcess('codex', 'success', 1000, new AbortController().signal, () => { throw new Error('do not return provider details'); });
  expect(observation).toMatchObject({ reason: 'protocol-error', closed: true });
  expect(JSON.stringify(observation)).not.toContain('provider details');
});

it('imports the public adapters entrypoint in native Node strip-only mode', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import {CodexFixtureProcessAdapter} from './packages/adapters/src/index.ts'; if(new CodexFixtureProcessAdapter().id !== 'codex-protocol-process-fixture') process.exitCode=1"], { encoding: 'utf8', env: {} });
  expect(result.status, result.stderr).toBe(0);
});
