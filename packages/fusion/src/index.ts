import type { AgentAdapter, ContextScope, HandoffCapsule } from '../../execution/src/index.ts';
import { validateContextScope, sameScope } from '../../execution/src/index.ts';
import { ContextBroker } from '../../context/src/index.ts';
import type { VerifyEvidence } from '../../context/src/index.ts';
import { EventStore } from '../../event-store/src/index.ts';
import { bounded, canonical, digest, ensure, fields, label } from '../../autodev/src/contracts.ts';
export type FusionStrategy = 'single' | 'specialist-chain' | 'parallel-review' | 'fallback';
export interface AdapterProfile {
  adapter: AgentAdapter; skills: string[]; roles: ('coder' | 'reviewer')[]; independentScore: number;
  evidenceRef: string; allowedRepos: string[];
}
export interface RouteRequest {
  decisionId: string; scope: ContextScope; category: string; requiredSkills: string[];
  allowedAdapters: string[]; independentReview: boolean; budgetId: string; maxInvocations: number;
  policyDecisionId: string; evidenceRefs: string[];
  fallbackFrom: string | null; capsule: HandoffCapsule | null;
}
export interface FusionDecision {
  schemaVersion: 1; decisionId: string; taskId: string; strategyVersion: 'host-preview-v1'; mode: 'host-assisted-preview';
  strategy: FusionStrategy; selectedAdapters: string[]; roles: { adapterId: string; role: 'coder' | 'reviewer' | 'fallback' }[];
  candidateCapabilities: Record<string, string[]>; decisionEvidenceRefs: string[]; budgetId: string;
  risk: 'low'; policyDecisionId: string; category: string; reason: string; reservedInvocations: number;
  totalReservedInvocations: number; visitedAdapters: string[]; fallbackDepth: number; handoff: HandoffCapsule | null;
  gain: 'NOT_PROVEN';
}
/** Decision/audit controller only. It probes SDK capabilities and validates accepted
 * handoff capsules using ContextBroker, but NEVER starts an adapter. Routing does
 * not prove real heterogeneous execution, isolation, or fusion performance. */
export class FusionPreviewRouter {
  private readonly profiles: AdapterProfile[];
  private readonly adapterIds = new Map<AgentAdapter, string>();
  private readonly budgetLimit: number;
  private readonly store: EventStore;
  private readonly verifyEvidence: VerifyEvidence;
  private readonly clock: () => number;
  constructor(store: EventStore, profiles: AdapterProfile[], verifyEvidence: VerifyEvidence, clock: () => number = Date.now, maxInvocations = 100) {
    this.store = store; this.verifyEvidence = verifyEvidence; this.clock = clock;
    bounded(maxInvocations, 0, 100_000); this.budgetLimit = maxInvocations;
    ensure(profiles.length > 0 && profiles.length <= 20, 'Bounded adapter candidates required');
    ensure(new Set(profiles.map(p => p.adapter.id)).size === profiles.length, 'Duplicate adapter identity');
    this.profiles = profiles.map(p => {
      fields(p, ['adapter', 'skills', 'roles', 'independentScore', 'evidenceRef', 'allowedRepos']); label(p.adapter.id); label(p.evidenceRef);
      for (const values of [p.skills, p.roles, p.allowedRepos]) { ensure(Array.isArray(values) && values.length > 0 && new Set(values).size === values.length, 'Invalid profile list'); values.forEach(label); }
      ensure(p.roles.every(r => r === 'coder' || r === 'reviewer'), 'Unknown adapter role'); bounded(p.independentScore, 0, 100);
      this.adapterIds.set(p.adapter, p.adapter.id);
      return { ...p, skills: [...p.skills], roles: [...p.roles], allowedRepos: [...p.allowedRepos] };
    });
    store.transaction(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS fusion_preview_config(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fusion_preview_decisions(decision_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, parent_id TEXT UNIQUE, request_digest TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fusion_preview_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, decision_id TEXT NOT NULL, json TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS fusion_preview_no_update BEFORE UPDATE ON fusion_preview_decisions BEGIN SELECT RAISE(ABORT,'immutable decision'); END;
CREATE TRIGGER IF NOT EXISTS fusion_preview_no_delete BEFORE DELETE ON fusion_preview_decisions BEGIN SELECT RAISE(ABORT,'immutable decision'); END;
CREATE TRIGGER IF NOT EXISTS fusion_preview_audit_no_update BEFORE UPDATE ON fusion_preview_audit BEGIN SELECT RAISE(ABORT,'immutable audit'); END;
CREATE TRIGGER IF NOT EXISTS fusion_preview_audit_no_delete BEFORE DELETE ON fusion_preview_audit BEGIN SELECT RAISE(ABORT,'immutable audit'); END;`);
      const config = canonical({ maxInvocations, profiles: this.profiles.map(p => ({ ...p, adapter: p.adapter.id })) });
      store.db.prepare('INSERT OR IGNORE INTO fusion_preview_config VALUES(1,?)').run(config);
      ensure(store.db.prepare('SELECT json FROM fusion_preview_config WHERE id=1').get()?.json === config, 'Routing profiles and budgets cannot silently change');
    });
  }
  private audit(kind: string, id: string, data: unknown): void { const now = this.clock(); bounded(now, 0, Number.MAX_SAFE_INTEGER); this.store.db.prepare('INSERT INTO fusion_preview_audit(at,kind,decision_id,json) VALUES(?,?,?,?)').run(now, kind, id, canonical(data)); }
  explain(id: string): FusionDecision | undefined { const row = this.store.db.prepare('SELECT json FROM fusion_preview_decisions WHERE decision_id=?').get(id); return row ? JSON.parse(String(row.json)) as FusionDecision : undefined; }
  auditLog(): object[] { return this.store.db.prepare('SELECT * FROM fusion_preview_audit ORDER BY sequence').all(); }
  private checkIdentities(): void { for (const profile of this.profiles) ensure(profile.adapter.id === this.adapterIds.get(profile.adapter), 'Adapter identity drift from pinned host configuration'); }
  private validate(request: RouteRequest): void {
    this.checkIdentities();
    fields(request, ['decisionId', 'scope', 'category', 'requiredSkills', 'allowedAdapters', 'independentReview', 'budgetId', 'maxInvocations', 'policyDecisionId', 'evidenceRefs', 'fallbackFrom', 'capsule']);
    validateContextScope(request.scope); [request.decisionId, request.category, request.budgetId, request.policyDecisionId].forEach(label);
    for (const values of [request.requiredSkills, request.allowedAdapters, request.evidenceRefs]) { ensure(Array.isArray(values) && values.length > 0 && values.length <= 20 && new Set(values).size === values.length, 'Invalid route list'); values.forEach(label); }
    bounded(request.maxInvocations, 0, this.budgetLimit); ensure(typeof request.independentReview === 'boolean', 'Invalid review flag');
    ensure(request.allowedAdapters.every(id => this.profiles.some(p => p.adapter.id === id)), 'Unknown authorized adapter');
    if (request.fallbackFrom !== null) label(request.fallbackFrom);
    ensure(request.fallbackFrom !== null || request.capsule === null, 'Unexpected handoff without fallback');
  }
  async route(input: RouteRequest, signal: AbortSignal = new AbortController().signal): Promise<FusionDecision> {
    this.validate(input); const request = structuredClone(input); const fingerprint = digest(request);
    const prior = this.store.db.prepare('SELECT request_digest FROM fusion_preview_decisions WHERE decision_id=?').get(request.decisionId);
    if (prior) { ensure(prior.request_digest === fingerprint, 'Decision idempotency collision'); return this.explain(request.decisionId)!; }
    try {
      ensure(!signal.aborted, 'Routing cancelled');
      const profiles = this.profiles.filter(p => request.allowedAdapters.includes(p.adapter.id) && p.allowedRepos.includes(request.scope.repo));
      const capabilities: Record<string, string[]> = {};
      const eligible: AdapterProfile[] = [];
      for (const profile of profiles) {
        ensure(!signal.aborted, 'Routing cancelled');
        // Host SDK capability probe, not a provider/model invocation.
        const capability = await this.probe(profile.adapter, signal);
        this.checkIdentities();
        fields(capability, ['streaming', 'resume', 'cancellation', 'toolCalls', 'contextHandoff']);
        ensure(['streaming', 'resume', 'cancellation', 'toolCalls'].every(k => typeof capability[k as keyof typeof capability] === 'boolean') && ['summary', 'native', 'none'].includes(capability.contextHandoff), 'Invalid SDK capabilities');
        capabilities[profile.adapter.id] = [...profile.skills, `handoff:${capability.contextHandoff}`, `cancellation:${capability.cancellation}`];
        if (capability.cancellation && (request.fallbackFrom === null || capability.contextHandoff !== 'none')) eligible.push(profile);
      }
      ensure(!signal.aborted, 'Routing cancelled');
      eligible.sort((a, b) => b.independentScore - a.independentScore || a.adapter.id.localeCompare(b.adapter.id));
      return this.store.transaction(() => {
        // Another async caller may have completed while capability probes awaited.
        const raced = this.store.db.prepare('SELECT request_digest FROM fusion_preview_decisions WHERE decision_id=?').get(request.decisionId);
        if (raced) { ensure(raced.request_digest === fingerprint, 'Decision idempotency collision'); return this.explain(request.decisionId)!; }
        let selected: AdapterProfile[] = []; let strategy: FusionStrategy = 'single'; let reason = 'Best independently scored eligible single adapter covers task';
        let handoff: HandoffCapsule | null = null; let depth = 0; let visited: string[] = []; let total = 0;
        const covers = (p: AdapterProfile): boolean => request.requiredSkills.every(s => p.skills.includes(s));
        const coders = eligible.filter(p => p.roles.includes('coder'));
        if (request.fallbackFrom !== null) {
          const previous = this.explain(request.fallbackFrom); ensure(previous && previous.taskId === request.scope.taskId && previous.policyDecisionId === request.policyDecisionId && previous.budgetId === request.budgetId, 'Fallback authority or task mismatch');
          const oldRow = this.store.db.prepare('SELECT json FROM fusion_preview_audit WHERE kind=? AND decision_id=?').get('fusion.request', request.fallbackFrom);
          ensure(oldRow, 'Fallback provenance missing'); const old = JSON.parse(String(oldRow.json)) as RouteRequest;
          ensure(sameScope(old.scope, request.scope) && canonical(old.requiredSkills) === canonical(request.requiredSkills) && canonical(old.allowedAdapters) === canonical(request.allowedAdapters) && old.maxInvocations === request.maxInvocations && old.independentReview === request.independentReview && old.category === request.category, 'Fallback cannot expand scope, budget, or change acceptance');
          ensure(previous.fallbackDepth < 2 && request.capsule !== null, 'Fallback bound or required capsule');
          const broker = new ContextBroker(request.scope, this.verifyEvidence, this.clock); handoff = broker.accept(request.capsule);
          visited = [...previous.visitedAdapters]; total = previous.totalReservedInvocations; depth = previous.fallbackDepth + 1;
          const next = coders.find(p => !visited.includes(p.adapter.id) && covers(p)); ensure(next, 'No unvisited capable fallback adapter');
          selected = [next]; strategy = 'fallback'; reason = 'Bounded failed-worker takeover with accepted evidence capsule';
          if (request.independentReview) { const reviewer = eligible.find(p => p.adapter.id !== next.adapter.id && p.roles.includes('reviewer') && !visited.includes(p.adapter.id)); ensure(reviewer, 'Independent fallback review unavailable'); selected.push(reviewer); }
        } else if (request.independentReview) {
          const coder = coders.find(covers); ensure(coder, 'No single coder covers task');
          const reviewer = eligible.find(p => p.adapter.id !== coder.adapter.id && p.roles.includes('reviewer')); ensure(reviewer, 'Independent reviewer unavailable');
          selected = [coder, reviewer]; strategy = 'parallel-review'; reason = 'Separate coder and independently bound reviewer requested; no shared writable worktree implied';
        } else {
          const single = coders.find(covers);
          if (single) selected = [single];
          else {
            // Bounded deterministic pair search: do not mistake arbitrary switching for fusion.
            outer: for (const a of coders) for (const b of coders) if (a !== b && request.requiredSkills.every(s => a.skills.includes(s) || b.skills.includes(s))) { selected = [a, b]; break outer; }
            ensure(selected.length === 2, 'No eligible specialist chain covers task'); strategy = 'specialist-chain'; reason = 'No single covers all skills; two complementary specialists selected for sequential host work';
          }
        }
        ensure(total + selected.length <= request.maxInvocations, 'Per-task shared invocation budget exhausted');
        const all = this.store.db.prepare('SELECT json FROM fusion_preview_decisions').all().map(r => JSON.parse(String(r.json)) as FusionDecision);
        ensure(all.reduce((n, d) => n + d.reservedInvocations, 0) + selected.length <= this.budgetLimit, 'Global routing invocation budget exhausted');
        ensure(!all.some(d => d.taskId === request.scope.taskId && request.fallbackFrom === null), 'Task already has a root routing decision');
        ensure(!signal.aborted, 'Routing cancelled');
        this.checkIdentities();
        const decision: FusionDecision = { schemaVersion: 1, decisionId: request.decisionId, taskId: request.scope.taskId, strategyVersion: 'host-preview-v1', mode: 'host-assisted-preview', strategy, selectedAdapters: selected.map(p => p.adapter.id), roles: selected.map((p, i) => ({ adapterId: p.adapter.id, role: request.independentReview && i === 1 ? 'reviewer' : strategy === 'fallback' ? 'fallback' : 'coder' })), candidateCapabilities: capabilities, decisionEvidenceRefs: [...request.evidenceRefs, ...selected.map(p => p.evidenceRef)], budgetId: request.budgetId, risk: 'low', policyDecisionId: request.policyDecisionId, category: request.category, reason, reservedInvocations: selected.length, totalReservedInvocations: total + selected.length, visitedAdapters: [...new Set([...visited, ...selected.map(p => p.adapter.id)])], fallbackDepth: depth, handoff, gain: 'NOT_PROVEN' };
        this.store.db.prepare('INSERT INTO fusion_preview_decisions VALUES(?,?,?,?,?)').run(request.decisionId, request.scope.taskId, request.fallbackFrom, fingerprint, canonical(decision));
        this.audit('fusion.request', request.decisionId, { ...request, capsule: null }); this.audit(strategy === 'fallback' ? 'fusion.fallback_started' : 'fusion.decision_recorded', request.decisionId, decision); return structuredClone(decision);
      });
    } catch (error) { this.audit('fusion.denied', request.decisionId, { reason: 'Routing contract, scope, capability, cancellation, or budget rejected', requestDigest: fingerprint }); throw error; }
  }
  private async probe(adapter: AgentAdapter, signal: AbortSignal): ReturnType<AgentAdapter['capabilities']> {
    let listener: (() => void) | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => { ensure(!signal.aborted, 'Capability probe cancelled'); return adapter.capabilities(); }), new Promise<never>((_, reject) => {
        listener = () => reject(new Error('Capability probe cancelled')); signal.addEventListener('abort', listener, { once: true });
        timer = setTimeout(() => reject(new Error('Capability probe timeout')), 1000);
      })]);
    } finally { if (listener) signal.removeEventListener('abort', listener); if (timer) clearTimeout(timer); }
  }
}
