import { AdapterContractError, sameScope, validateContextScope, validateHandoffCapsule } from '../../execution/src/index.ts';
import type { ContextFact, ContextScope, HandoffCapsule, ReadOnlyReference } from '../../execution/src/index.ts';
export type { ContextFact, ContextScope, HandoffCapsule, ReadOnlyReference } from '../../execution/src/index.ts';
export interface ContextAuditEvent { action: 'accepted' | 'read' | 'expired' | 'denied'; capsuleId: string; at: string }
/** Injected by the trusted host, never from adapter/model output. It must verify the
 * claim against evidence bytes/digest/version, not merely trust a label or URI. */
export type VerifyEvidence = (fact: Readonly<ContextFact>, evidence: readonly ReadOnlyReference[], scope: Readonly<ContextScope>) => boolean;
/** In-memory, offline broker. One instance is bound to one exact scope. No global
 * lookup, persistence, network, tool execution, or policy/permission mutation API. */
export class ContextBroker {
  private readonly scope: ContextScope;
  private readonly verifyEvidence: VerifyEvidence;
  private readonly now: () => number;
  private readonly capsules = new Map<string, HandoffCapsule>();
  private readonly audit: ContextAuditEvent[] = [];
  constructor(scope: ContextScope, verifyEvidence: VerifyEvidence, now: () => number = Date.now) {
    validateContextScope(scope);
    if (typeof verifyEvidence !== 'function' || typeof now !== 'function') throw new AdapterContractError('Trusted verifier and clock required');
    this.scope = structuredClone(scope); this.verifyEvidence = verifyEvidence; this.now = now;
  }
  private record(action: ContextAuditEvent['action'], capsuleId: string): void {
    this.audit.push({ action, capsuleId, at: new Date(this.now()).toISOString() });
  }
  accept(value: unknown): HandoffCapsule {
    // Validate before cloning: serialization must not strip unknown/prototype fields.
    validateHandoffCapsule(value, this.now());
    const candidate = structuredClone(value);
    if (!sameScope(this.scope, candidate.scope)) { this.record('denied', candidate.id); throw new AdapterContractError('Scope mismatch'); }
    if (this.capsules.has(candidate.id)) throw new AdapterContractError('Capsule IDs are immutable');
    for (const fact of candidate.facts) {
      if (fact.classification === 'verified') {
        const evidence = candidate.references.filter(ref => fact.evidenceRefs.includes(ref.id));
        if (this.verifyEvidence(structuredClone(fact), structuredClone(evidence), structuredClone(this.scope)) !== true) {
          this.record('denied', candidate.id); throw new AdapterContractError('Evidence was not verified by trusted host');
        }
      }
    }
    // Trusted verification may take time: enforce TTL again at the admission boundary.
    validateHandoffCapsule(candidate, this.now());
    // Verification callback cannot promote inferred claims or change stored facts.
    this.capsules.set(candidate.id, structuredClone(candidate)); this.record('accepted', candidate.id);
    return structuredClone(candidate);
  }
  get(id: string, scope: ContextScope): HandoffCapsule | undefined {
    validateContextScope(scope);
    if (!sameScope(this.scope, scope)) { this.record('denied', 'scope-mismatch'); throw new AdapterContractError('Scope mismatch'); }
    const capsule = this.capsules.get(id);
    if (!capsule) return undefined;
    try { validateHandoffCapsule(capsule, this.now()); }
    catch { this.capsules.delete(id); this.record('expired', id); return undefined; }
    this.record('read', id); return structuredClone(capsule);
  }
  auditLog(): ContextAuditEvent[] { return structuredClone(this.audit); }
}
