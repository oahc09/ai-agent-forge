import { describe, expect, it, vi } from 'vitest';
import { ContextBroker } from '../../packages/context/src/index.ts';
import { validateHandoffCapsule } from '../../packages/execution/src/index.ts';
import { FakeAdapter } from '../../packages/adapters/src/index.ts';
import { capsule, input } from './adapter-fixtures.ts';
describe('offline scoped context broker', () => {
  it('transfers verified facts from A to B, preserving inferred claims', async () => {
    const c = capsule(); const verify = vi.fn((fact, refs) => fact.text === 'Test suite passed.' && refs[0].sha256 === 'a'.repeat(64));
    const broker = new ContextBroker(c.scope, verify); broker.accept(c); const handoff = broker.get(c.id, c.scope)!;
    expect(handoff.facts[0]?.classification).toBe('verified'); expect(handoff.facts[1]?.classification).toBe('inferred'); expect(verify).toHaveBeenCalledTimes(1);
    for (const runId of ['agent-a', 'agent-b']) { const v = input(); v.runId = runId; v.capsule = handoff; const events = []; for await (const event of new FakeAdapter({ requireContext: true }).start(v, new AbortController().signal)) events.push(event); expect(events.at(-1)).toMatchObject({ status: 'succeeded' }); }
    expect(broker.auditLog().map(e => e.action)).toEqual(['accepted','read']);
  });
  it('enforces TTL exactly and excludes future records', () => { let now = Date.now(); const c = capsule(now); const broker = new ContextBroker(c.scope, () => true, () => now); broker.accept(c); now = Date.parse(c.expiresAt) - 1; expect(broker.get(c.id, c.scope)).toBeDefined(); now++; expect(broker.get(c.id, c.scope)).toBeUndefined(); expect(broker.auditLog().at(-1)?.action).toBe('expired'); expect(() => validateHandoffCapsule(c, Date.parse(c.createdAt) - 1)).toThrow(); });
  it('rejects a capsule that expires during trusted evidence verification', () => { let now = Date.now(); const c = capsule(now); const broker = new ContextBroker(c.scope, () => { now = Date.parse(c.expiresAt); return true; }, () => now); expect(() => broker.accept(c)).toThrow('expired'); expect(broker.get(c.id, c.scope)).toBeUndefined(); expect(broker.auditLog().some(event => event.action === 'accepted')).toBe(false); });
  it('never aliases caller, verifier, or retrieval data', () => { const c = capsule(); const originalScope = structuredClone(c.scope); const broker = new ContextBroker(c.scope, (fact, evidence, scope) => { (fact as { text: string }).text = 'mutated'; evidence[0]!.uri = 'artifact:mutated'; (scope as { repo: string }).repo = 'other'; return true; }); const returned = broker.accept(c); returned.facts[0]!.text = 'changed'; c.facts[0]!.text = 'changed'; c.scope.repo = 'other'; const fetched = broker.get(c.id, originalScope)!; expect(fetched.facts[0]!.text).toBe('Test suite passed.'); expect(fetched.references[0]!.uri).toBe('artifact:test-log'); fetched.facts[0]!.classification = 'inferred'; expect(broker.get(c.id, originalScope)!.facts[0]!.classification).toBe('verified'); });
  it('does not overwrite immutable capsule IDs', () => { const c = capsule(); const broker = new ContextBroker(c.scope, () => true); broker.accept(c); expect(() => broker.accept(c)).toThrow('immutable'); });
  it('returns missing only inside correct scope', () => { const c = capsule(); expect(new ContextBroker(c.scope, () => false).get('missing', c.scope)).toBeUndefined(); });
  it.each(['references','facts'])('rejects duplicate %s', field => { const c = capsule(); if (field === 'facts') c.facts.push(c.facts[0]!); else c.references.push(c.references[0]!); expect(() => validateHandoffCapsule(c)).toThrow(); });
});
