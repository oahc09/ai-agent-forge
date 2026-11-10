import { describe, expect, it } from 'vitest';
import inputSchema from '../../packages/execution/schemas/agent-input.schema.json' with { type: 'json' };
import capsuleSchema from '../../packages/execution/schemas/agent-capsule.schema.json' with { type: 'json' };
import checkpointSchema from '../../packages/execution/schemas/agent-checkpoint.schema.json' with { type: 'json' };
import eventSchema from '../../packages/execution/schemas/agent-event.schema.json' with { type: 'json' };
import {
  validateAgentCheckpoint, validateAgentRunEvent, validateAgentRunInput, validateHandoffCapsule,
} from '../../packages/execution/src/index.ts';
import type { AgentCheckpoint, AgentRunEvent } from '../../packages/execution/src/index.ts';
import { capsule, input } from './adapter-fixtures.ts';

const entrypoints = [
  { name: 'input', schema: inputSchema },
  { name: 'capsule', schema: capsuleSchema },
  { name: 'checkpoint', schema: checkpointSchema },
  { name: 'event', schema: eventSchema },
];

// Traverse arrays as well as objects so union branches and nested items are checked.
function referencesIn(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(referencesIn);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => key === '$ref' ? [child] : referencesIn(child));
}

describe('execution JSON-schema entrypoint parity', () => {
  it.each(entrypoints)('$name uses the expected draft, identity and root definition', ({ name, schema }) => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe(`https://agent-forge.invalid/schemas/agent-${name}.schema.json`);
    expect(schema.$ref).toBe(`#/$defs/${name}`);
    expect(Object.hasOwn(schema.$defs, name)).toBe(true);
  });

  it.each(entrypoints)('$name shares the complete runtime definition set', ({ schema }) => {
    // The runtime imports inputSchema, so compare every standalone entrypoint to it.
    expect(schema.$defs).toEqual(inputSchema.$defs);
  });

  it.each(entrypoints)('$name resolves every reference within its own definitions', ({ schema }) => {
    const refs = referencesIn(schema);
    expect(refs.length).toBeGreaterThan(1);
    for (const ref of refs) {
      // The runtime evaluator supports direct local definition references only.
      expect(ref).toEqual(expect.stringMatching(/^#\/\$defs\/[^/]+$/));
      const key = (ref as string).slice('#/$defs/'.length);
      expect(Object.hasOwn(schema.$defs, key), `Unresolved reference: ${String(ref)}`).toBe(true);
    }
  });

  it('finds references in nested properties, array items and union branches', () => {
    expect(referencesIn({ properties: { value: { items: { anyOf: [
      { $ref: '#/$defs/missing' }, { properties: { child: { $ref: '#/$defs/id' } } },
    ] } } } })).toEqual(['#/$defs/missing', '#/$defs/id']);
  });
});

// Explicit clocks keep lifetime-sensitive fixtures deterministic, even years later.
const now = Date.parse('2026-11-08T12:00:00.000Z');

describe('schema entrypoint runtime fixtures', () => {
  it('accepts input with both null and populated handoff context', () => {
    expect(() => validateAgentRunInput(input(now), now)).not.toThrow();
    expect(() => validateAgentRunInput({ ...input(now), capsule: capsule(now) }, now)).not.toThrow();
  });

  it('accepts the shared capsule fixture', () => {
    expect(() => validateHandoffCapsule(capsule(now), now)).not.toThrow();
  });

  it('accepts a checkpoint containing the shared capsule fixture', () => {
    const context = capsule(now);
    const checkpoint: AgentCheckpoint = {
      schemaVersion: 1, taskId: context.scope.taskId, runId: 'run-1', adapterId: 'fake-offline',
      scope: context.scope, createdAt: new Date(now).toISOString(), expiresAt: context.expiresAt,
      capsule: context, lastSequence: 2, recovery: 'new-session-with-summary',
    };
    expect(() => validateAgentCheckpoint(checkpoint, now)).not.toThrow();
  });

  const base = { schemaVersion: 1 as const, taskId: 'task-1', runId: 'run-1', sequence: 1, occurredAt: new Date(now).toISOString() };
  const events: AgentRunEvent[] = [
    ...(['running', 'succeeded', 'cancelled'] as const).map(status => ({ ...base, type: 'status' as const, status })),
    { ...base, type: 'output', text: 'Offline schema fixture.' },
    ...(['TIMEOUT', 'ADAPTER_FAILURE', 'CONTEXT_MISSING'] as const).map(code => ({
      ...base, type: 'failure' as const, status: 'failed' as const, code, retryable: code !== 'CONTEXT_MISSING',
    })),
  ];
  it.each(events)('accepts event fixture $type ($status $code)', event => {
    expect(() => validateAgentRunEvent(event)).not.toThrow();
  });
});
