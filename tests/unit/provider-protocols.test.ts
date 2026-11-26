import { describe, expect, it } from 'vitest';
import { CodexJsonlDecoder, OpenCodeJsonlDecoder } from '../../packages/adapters/src/index.ts';
import { AgentEventStreamValidator } from '../../packages/execution/src/index.ts';
import type { AgentRunEvent } from '../../packages/execution/src/index.ts';
import { input } from './adapter-fixtures.ts';

// Hand-authored protocol fixtures, not captured model executions or billing evidence.
const codex = [
  { type: 'thread.started', thread_id: 'thread-1' }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: 'Candidate prepared' } },
  { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3, cached_input_tokens: 2 } },
];
const oc = (type: string, part: Record<string, unknown>): { type: string; timestamp: number; sessionID: string; part: Record<string, unknown> } => ({ type, timestamp: 1, sessionID: 'session-1', part: { id: `part-${type}`, sessionID: 'session-1', messageID: 'message-1', ...part } });
const opencode = [oc('step_start', { type: 'step-start' }), oc('text', { type: 'text', text: 'Candidate prepared' }),
  oc('step_finish', { type: 'step-finish', reason: 'stop', cost: 0.002, tokens: { input: 10, output: 3, reasoning: 1, cache: { read: 2, write: 0 } } })];
const variants = [{ name: 'Codex', make: () => new CodexJsonlDecoder(input()), lines: codex },
  { name: 'OpenCode', make: () => new OpenCodeJsonlDecoder(input()), lines: opencode }];
for (const variant of variants) describe(variant.name, () => {
  it('normalizes output and requires observed exit before success', () => {
    const decoder = variant.make();
    const events = variant.lines.flatMap(line => decoder.acceptLine(JSON.stringify(line)));
    expect(events.map(event => event.type)).toEqual(['status']);
    expect(events.some(event => event.type === 'status' && event.status === 'succeeded')).toBe(false);
    events.push(...decoder.finish(0));
    const validator: AgentEventStreamValidator = new AgentEventStreamValidator('task-1', 'run-1');
    for (const event of events) validator.accept(event);
    validator.finish();
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'succeeded' });
    expect(decoder.reportedUsage()[0]).toMatchObject({ inputTokens: 10, outputTokens: 3, cachedInputTokens: 2 });
    const copy = decoder.reportedUsage(); copy.length = 0;
    expect(decoder.reportedUsage()).toHaveLength(1);
    expect(() => decoder.finish(0)).toThrow();
    expect(() => decoder.acceptLine('{}')).toThrow();
  });
  it.each([1, null])('refuses success after provider completion when process exit is %s', exit => {
    const decoder = variant.make();
    variant.lines.forEach(line => decoder.acceptLine(JSON.stringify(line)));
    expect(decoder.finish(exit).at(-1)).toMatchObject({ type: 'failure', code: 'ADAPTER_FAILURE' });
  });
  it('rejects empty/truncated protocol even if process exits zero', () => {
    expect(variant.make().finish(0).at(-1)).toMatchObject({ type: 'failure' });
    const decoder = variant.make(); decoder.acceptLine(JSON.stringify(variant.lines[0]));
    expect(decoder.finish(0).at(-1)).toMatchObject({ type: 'failure' });
  });
  it.each(['', 'not-json', 'null', '[]', '{"type":"unexpected"}', 'x'.repeat(65537)])('rejects invalid or oversized input without echoing it', line => {
    const decoder = variant.make();
    expect(() => decoder.acceptLine(line)).toThrow('Invalid or unsupported provider protocol');
    expect(() => decoder.acceptLine(JSON.stringify(variant.lines[0]))).toThrow();
    expect(decoder.finish(0).at(-1)).toMatchObject({ type: 'failure' });
  });
  it.each(['cancelled', 'timeout'] as const)('records trusted runner %s outcome without pretending to stop a process', outcome => {
    const decoder = variant.make();
    const events = decoder.finish(null, outcome);
    expect(events.at(-1)).toMatchObject(outcome === 'cancelled' ? { status: 'cancelled' } : { code: 'TIMEOUT' });
  });
  it('treats provider error as failure and never exposes its message', () => {
    const decoder = variant.make();
    const events = decoder.acceptLine(JSON.stringify({ type: 'error', message: 'private-provider-detail', error: { message: 'private-provider-detail' } }));
    events.push(...decoder.finish(0));
    expect(events.at(-1)).toMatchObject({ type: 'failure' });
    expect(JSON.stringify(events)).not.toContain('private-provider-detail');
  });
  it('rejects invalid usage and terminal records replay', () => {
    const decoder = variant.make();
    variant.lines.forEach(line => decoder.acceptLine(JSON.stringify(line)));
    expect(() => decoder.acceptLine(JSON.stringify(variant.lines.at(-1)))).toThrow();
    expect(decoder.finish(0).at(-1)).toMatchObject({ type: 'failure' });
  });
});
it('keeps Codex unavailable cost and optional token dimensions unknown, not zero', () => {
  const decoder = new CodexJsonlDecoder(input()); codex.forEach(line => decoder.acceptLine(JSON.stringify(line)));
  expect(decoder.reportedUsage()[0]).toMatchObject({ reportedCostUsd: null, cacheWriteTokens: null, reasoningTokens: null });
});
it('does not mistake OpenCode tool-calls steps or later background failure for success', () => {
  const decoder = new OpenCodeJsonlDecoder(input());
  decoder.acceptLine(JSON.stringify(opencode[0]));
  const finished = structuredClone(opencode[2]!); finished.part.reason = 'tool-calls';
  decoder.acceptLine(JSON.stringify(finished));
  expect(decoder.finish(0).at(-1)).toMatchObject({ type: 'failure' });
  const background = new OpenCodeJsonlDecoder(input()); opencode.forEach(line => background.acceptLine(JSON.stringify(line)));
  background.acceptLine(JSON.stringify({ type: 'background_wait', sessionID: 'session-1', jobs: [] }));
  background.acceptLine(JSON.stringify({ type: 'error', sessionID: 'session-1', error: { message: 'job failed' } }));
  expect(background.finish(0).at(-1)).toMatchObject({ type: 'failure' });
});
it('rejects cross-session text and never treats tool records as executable instructions', () => {
  const decoder = new OpenCodeJsonlDecoder(input()); decoder.acceptLine(JSON.stringify(opencode[0]));
  expect(decoder.acceptLine(JSON.stringify(oc('tool_use', { type: 'tool', state: { input: { command: 'never execute this' } } })))).toEqual([]);
  expect(() => decoder.acceptLine(JSON.stringify({ ...opencode[1], sessionID: 'other-session' }))).toThrow();
});
it('rejects credential-like output without emitting a partial running event or leaking input', () => {
  for (const variant of variants) {
    const decoder = variant.make(); const events: AgentRunEvent[] = [];
    const lines = structuredClone(variant.lines) as Array<Record<string, unknown>>;
    const output = lines.find(line => line.type === 'text' || line.type === 'item.completed')!;
    const part = (output.item ?? output.part) as Record<string, unknown>;
    part.text = 'password=DO_NOT_RETURN';
    for (const line of lines) {
      try { events.push(...decoder.acceptLine(JSON.stringify(line))); } catch { break; }
    }
    events.push(...decoder.finish(0));
    expect(JSON.stringify(events)).not.toContain('DO_NOT_RETURN');
    const validator: AgentEventStreamValidator = new AgentEventStreamValidator('task-1', 'run-1');
    events.forEach(event => validator.accept(event)); validator.finish();
  }
});
it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid Codex usage %s', value => {
  const decoder = new CodexJsonlDecoder(input()); codex.slice(0, 3).forEach(line => decoder.acceptLine(JSON.stringify(line)));
  expect(() => decoder.acceptLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: value, output_tokens: 1, cached_input_tokens: 0 } }))).toThrow();
});
it('rejects Codex completion with an unfinished tool and duplicate item start', () => {
  for (const duplicate of [false, true]) {
    const decoder = new CodexJsonlDecoder(input()); codex.slice(0, 2).forEach(line => decoder.acceptLine(JSON.stringify(line)));
    const start = { type: 'item.started', item: { type: 'command_execution', id: 'tool-1' } };
    decoder.acceptLine(JSON.stringify(start));
    expect(() => decoder.acceptLine(JSON.stringify(duplicate ? start : codex.at(-1)))).toThrow();
    expect(decoder.finish(0).at(-1)).toMatchObject({ type: 'failure' });
  }
});
it('supports multiple distinct OpenCode tool steps before the final stop', () => {
  const decoder = new OpenCodeJsonlDecoder(input());
  const first = structuredClone(opencode);
  first[2]!.part.reason = 'tool-calls';
  first.forEach(line => decoder.acceptLine(JSON.stringify(line)));
  const second = structuredClone(opencode);
  second.forEach(line => { line.part.messageID = 'message-2'; decoder.acceptLine(JSON.stringify(line)); });
  expect(decoder.finish(0).at(-1)).toMatchObject({ status: 'succeeded' });
  expect(decoder.reportedUsage()).toHaveLength(2);
});
it('does not report missing OpenCode cost as free and rejects invalid cost/tokens', () => {
  for (const cost of [undefined, -1, Infinity]) {
    const decoder = new OpenCodeJsonlDecoder(input()); decoder.acceptLine(JSON.stringify(opencode[0]));
    const line = structuredClone(opencode[2]!);
    if (cost === undefined) {
      delete line.part.cost;
      decoder.acceptLine(JSON.stringify(line));
      expect(decoder.reportedUsage()[0]?.reportedCostUsd).toBeNull();
    } else {
      line.part.cost = cost;
      expect(() => decoder.acceptLine(JSON.stringify(line))).toThrow();
    }
  }
});
it('never releases credential-like text split across OpenCode records', () => {
  const decoder = new OpenCodeJsonlDecoder(input());
  const events = decoder.acceptLine(JSON.stringify(opencode[0]));
  for (const text of ['pass', 'word=DO_NOT_RETURN']) events.push(...decoder.acceptLine(JSON.stringify(oc('text', { type: 'text', text }))));
  events.push(...decoder.acceptLine(JSON.stringify(opencode[2])), ...decoder.finish(0));
  expect(events.at(-1)).toMatchObject({ type: 'failure' });
  expect(events.some(event => event.type === 'output')).toBe(false);
});
it('preserves whitespace-only OpenCode text deltas in the complete bounded response', () => {
  const decoder = new OpenCodeJsonlDecoder(input());
  decoder.acceptLine(JSON.stringify(opencode[0]));
  for (const text of ['Hello', ' ', 'world', '\n', '  ', 'indented']) decoder.acceptLine(JSON.stringify(oc('text', { type: 'text', text })));
  decoder.acceptLine(JSON.stringify(opencode[2]));
  expect(decoder.finish(0)[0]).toMatchObject({ type: 'output', text: 'Hello world\n  indented' });
});
it.each(['error', 'content-filter', 'length', 'unknown'])('makes OpenCode %s terminal reasons sticky failures', reason => {
  const decoder = new OpenCodeJsonlDecoder(input());
  decoder.acceptLine(JSON.stringify(opencode[0]));
  const failed = structuredClone(opencode[2]!); failed.part.reason = reason;
  decoder.acceptLine(JSON.stringify(failed));
  const next = structuredClone(opencode[0]!); next.part.messageID = 'message-2';
  expect(() => decoder.acceptLine(JSON.stringify(next))).toThrow();
  expect(decoder.finish(0).at(-1)).toMatchObject({ type: 'failure' });
});
it('bounds cumulative text across individually valid lines and never emits it on failure', () => {
  const decoder = new OpenCodeJsonlDecoder(input()); decoder.acceptLine(JSON.stringify(opencode[0]));
  decoder.acceptLine(JSON.stringify(oc('text', { type: 'text', text: 'a'.repeat(4096) })));
  expect(() => decoder.acceptLine(JSON.stringify(oc('text', { type: 'text', text: 'b' })))).toThrow();
  expect(decoder.finish(0).some(event => event.type === 'output')).toBe(false);
});
it('accepts OpenCode reconcile text after step_finish but before trusted exit', () => {
  const decoder = new OpenCodeJsonlDecoder(input());
  decoder.acceptLine(JSON.stringify(opencode[0]));
  decoder.acceptLine(JSON.stringify(opencode[2]));
  expect(decoder.acceptLine(JSON.stringify(oc('text', { type: 'text', text: 'Late reconciled text' })))).toEqual([]);
  expect(decoder.finish(0)).toMatchObject([{ type: 'output', text: 'Late reconciled text' }, { status: 'succeeded' }]);
});
