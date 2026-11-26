import { randomUUID } from 'node:crypto';
import { makeTask } from '../../domain/src/index.ts';
import type { EventType, ForgeTask, KernelAuthority } from '../../domain/src/index.ts';
import { EventStore } from '../../event-store/src/index.ts';
import { parsePolicy } from '../../policy/src/index.ts';
import { issueOfflineGrant } from '../../policy/src/offline-grant.ts';
import { bounded, canonical, digest, ensure, fields, label, overlap, validateCandidate, validateCheck, validatePlan, validatePlanGraph } from './contracts.ts';
import type { Candidate, CheckResult, IntakeMetadata, PreviewConfig, TaskPlan } from './contracts.ts';
export * from './contracts.ts';
export interface PreviewLease { taskId: string; runId: string; token: string; until: number }
interface LeaseRow { task_id: string; run_id: string; token: string; until_ms: number; stage: string }
export interface HostContext { plan: TaskPlan; attempt: number; operationId: string; untrustedBodyRef: string; signal: AbortSignal }
/** Bind these callbacks in trusted host code. Callback identities are configuration,
 * not self-reported worker labels. This API is NOT an OS/process isolation boundary. */
export interface HostCallbacks {
  implement(context: HostContext): Promise<Candidate>;
  validate(context: HostContext, candidate: Candidate): Promise<CheckResult>;
  review(context: HostContext, candidate: Candidate, validation: CheckResult): Promise<CheckResult>;
}
export interface DeliveryDraft {
  schemaVersion: 1; mode: 'host-assisted-preview'; taskId: string; repo: string; branch: string;
  commit: string; artifactDigest: string; title: string; summary: string; validationRef: string; reviewRef: string;
  deliveryType: 'local_only'; remoteWrites: false; mergeAllowed: false;
}
export type DeliveryObservation = { state: 'unknown'; evidenceRef: string } | { state: 'absent'; evidenceRef: string } | { state: 'found'; evidenceRef: string; repo: string; branch: string; commit: string; prRef: string };
/** Privileged single-node OFFLINE coordinator. Existing EventStore remains task truth.
 * Its database/callbacks must never be available to candidate code. No Git, shell,
 * network, provider, sandbox, or external delivery implementation is present. */
export class HostAutoDevPreview {
  private readonly config: PreviewConfig;
  private readonly controllers = new Map<string, AbortController>();
  private readonly store: EventStore;
  private readonly clock: () => number;
  constructor(store: EventStore, config: PreviewConfig, clock: () => number = Date.now) {
    this.store = store; this.clock = clock;
    fields(config, ['repo', 'actors', 'labels', 'sourceKinds', 'maxConcurrent', 'maxResourceUnits', 'maxAttempts', 'maxInvocations', 'leaseMs', 'roles', 'policy']);
    label(config.repo); fields(config.roles, ['coder', 'validator', 'reviewer']); Object.values(config.roles).forEach(label);
    ensure(new Set(Object.values(config.roles)).size === 3, 'Coder, validator, and reviewer must be distinct host bindings');
    for (const values of [config.actors, config.labels, config.sourceKinds]) { ensure(Array.isArray(values) && values.length > 0 && new Set(values).size === values.length, 'Nonempty unique allowlist required'); values.forEach(label); }
    ensure(config.sourceKinds.every(k => ['issue', 'ci', 'manual', 'schedule'].includes(k)), 'Unknown source kind');
    bounded(config.maxConcurrent, 1, 3); bounded(config.maxResourceUnits, 1, 100); bounded(config.maxAttempts, 1, 3); bounded(config.maxInvocations, 0, 1_000_000); bounded(config.leaseMs, 1, 3_600_000);
    const policy = parsePolicy(config.policy);
    ensure(config.maxConcurrent <= policy.maxConcurrentWorkers && config.maxAttempts <= policy.maxAttempts, 'Preview limits exceed trusted policy');
    issueOfflineGrant(config.policy, { repo: config.repo, taskId: 'config-check', actor: config.roles.coder, now: this.now() });
    this.config = structuredClone(config);
    store.transaction(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS preview_config(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preview_intake(event_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, task_id TEXT UNIQUE NOT NULL, body_ref TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preview_plans(task_id TEXT PRIMARY KEY, json TEXT NOT NULL, grant_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preview_leases(task_id TEXT PRIMARY KEY, run_id TEXT UNIQUE NOT NULL, token TEXT NOT NULL, until_ms INTEGER NOT NULL, stage TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preview_evidence(run_id TEXT NOT NULL, stage TEXT NOT NULL, role TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(run_id,stage));
CREATE TABLE IF NOT EXISTS preview_drafts(task_id TEXT PRIMARY KEY, digest TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preview_delivery(task_id TEXT PRIMARY KEY, state TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preview_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, at INTEGER NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS preview_audit_no_update BEFORE UPDATE ON preview_audit BEGIN SELECT RAISE(ABORT,'immutable audit'); END;
CREATE TRIGGER IF NOT EXISTS preview_audit_no_delete BEFORE DELETE ON preview_audit BEGIN SELECT RAISE(ABORT,'immutable audit'); END;
CREATE TRIGGER IF NOT EXISTS preview_evidence_no_update BEFORE UPDATE ON preview_evidence BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
CREATE TRIGGER IF NOT EXISTS preview_evidence_no_delete BEFORE DELETE ON preview_evidence BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
CREATE TRIGGER IF NOT EXISTS preview_drafts_no_update BEFORE UPDATE ON preview_drafts BEGIN SELECT RAISE(ABORT,'immutable draft'); END;
CREATE TRIGGER IF NOT EXISTS preview_drafts_no_delete BEFORE DELETE ON preview_drafts BEGIN SELECT RAISE(ABORT,'immutable draft'); END;`);
      store.db.prepare('INSERT OR IGNORE INTO preview_config VALUES(1,?)').run(canonical(config));
      ensure(store.db.prepare('SELECT json FROM preview_config WHERE id=1').get()?.json === canonical(config), 'Preview configuration change requires a new reviewed store');
    });
  }
  private now(): number { const now = this.clock(); bounded(now, 0, Number.MAX_SAFE_INTEGER); return now; }
  private audit(task: string | null, kind: string, data: unknown): void { this.store.db.prepare('INSERT INTO preview_audit(task_id,at,kind,json) VALUES(?,?,?,?)').run(task, this.now(), kind, canonical(data)); }
  auditLog(taskId?: string): object[] { return this.store.db.prepare(`SELECT sequence,task_id,at,kind,json FROM preview_audit${taskId ? ' WHERE task_id=?' : ''} ORDER BY sequence`).all(...(taskId ? [taskId] : [])); }
  private task(id: string): ForgeTask { const task = this.store.getTask(id); ensure(task, 'Unknown task'); return task; }
  plan(id: string): TaskPlan { const row = this.store.db.prepare('SELECT json FROM preview_plans WHERE task_id=?').get(id); ensure(row, 'Not a preview task'); const value: unknown = JSON.parse(String(row.json)); validatePlan(value); return value; }
  private event(id: string, type: EventType, payload: Record<string, unknown>, authority: Partial<KernelAuthority> = {}): ForgeTask {
    return this.store.append({ taskId: id, expectedVersion: this.task(id).version, eventType: type, payload, actor: 'system:host-preview', idempotencyKey: randomUUID() }, { kind: 'kernel', ...authority });
  }
  private grant(id: string): { id: string; expiresAt: number } {
    const row = this.store.db.prepare('SELECT grant_json FROM preview_plans WHERE task_id=?').get(id); ensure(row, 'Unknown grant');
    const grant = JSON.parse(String(row.grant_json)) as { id: string; expiresAt: number }; ensure(grant.expiresAt > this.now(), 'Offline grant expired'); return grant;
  }
  /** metadata and plan are supplied by an authenticated host connector/config.
   * Body is never parsed as authority, commands, labels, paths, or acceptance. */
  intake(metadata: IntakeMetadata, untrustedBody: string, plan: TaskPlan): ForgeTask {
    fields(metadata, ['kind', 'repo', 'actor', 'labels', 'externalEventId', 'actionVersion']);
    for (const value of [metadata.repo, metadata.actor, metadata.externalEventId, metadata.actionVersion]) label(value);
    ensure(Array.isArray(metadata.labels) && metadata.labels.length <= 100, 'Invalid labels'); metadata.labels.forEach(label);
    ensure(typeof untrustedBody === 'string' && untrustedBody.length <= 100_000, 'Body too large'); validatePlan(plan);
    const accepted = metadata.repo === this.config.repo && this.config.actors.includes(metadata.actor) && this.config.sourceKinds.includes(metadata.kind) && this.config.labels.every(l => metadata.labels.includes(l));
    if (!accepted) { this.audit(null, 'intake.denied', { reason: 'source metadata not authorized', fingerprint: digest(metadata) }); throw new Error('Source metadata not authorized'); }
    const eventKey = digest([metadata.kind, metadata.repo, metadata.externalEventId, metadata.actionVersion]);
    const bodyRef = `untrusted:${digest(untrustedBody)}`; const fingerprint = digest({ metadata, bodyRef, plan });
    return this.store.transaction(() => {
      const prior = this.store.db.prepare('SELECT * FROM preview_intake WHERE event_key=?').get(eventKey);
      if (prior) { ensure(prior.fingerprint === fingerprint, 'Intake idempotency collision'); return this.task(String(prior.task_id)); }
      ensure(!this.store.getTask(plan.taskId), 'Task identity already exists');
      ensure(plan.maxAttempts <= this.config.maxAttempts && plan.resourceUnits <= this.config.maxResourceUnits, 'Plan exceeds host limits');
      const plans = this.store.db.prepare('SELECT json FROM preview_plans').all().map(r => JSON.parse(String(r.json)) as TaskPlan); validatePlanGraph([...plans, plan]);
      const grant = issueOfflineGrant(this.config.policy, { taskId: plan.taskId, repo: metadata.repo, actor: metadata.actor, now: this.now() });
      this.store.createTask(makeTask({ id: plan.taskId, title: plan.title, repo: metadata.repo, source: { kind: metadata.kind, ref: metadata.externalEventId }, allowedPaths: plan.allowedPaths, dependencies: plan.dependencies, acceptanceIds: plan.acceptanceIds, maxAttempts: plan.maxAttempts }), `preview:intake:${eventKey}`);
      this.store.db.prepare('INSERT INTO preview_plans VALUES(?,?,?)').run(plan.taskId, canonical(plan), canonical(grant));
      this.store.db.prepare('INSERT INTO preview_intake VALUES(?,?,?,?)').run(eventKey, fingerprint, plan.taskId, bodyRef);
      this.event(plan.taskId, 'task.triaged', { reason: 'Host-approved offline preview plan' });
      const task = this.event(plan.taskId, 'auth.granted', { reason: 'Offline grant only; no provider or remote writes' }, { policyDecisionId: grant.id, permissions: grant.permissions });
      this.audit(task.id, 'intake.accepted', { eventKey, bodyRef, metadata, planDigest: digest(plan), mode: 'host-assisted-preview' }); return task;
    });
  }
  claim(): PreviewLease | undefined {
    return this.store.transaction(() => {
      const active = this.store.db.prepare('SELECT task_id FROM preview_leases').all().map(r => this.plan(String(r.task_id)));
      if (active.length >= this.config.maxConcurrent) return;
      // Never race a different kernel on the same task database.
      const runtimeTable = this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_leases'").get();
      if (runtimeTable && this.store.db.prepare('SELECT task_id FROM runtime_leases LIMIT 1').get()) return;
      const invocations = Number(this.store.db.prepare("SELECT COUNT(*) AS n FROM preview_audit WHERE kind='callback.reserved'").get()?.n);
      if (invocations >= this.config.maxInvocations) return;
      const candidates = this.store.listTasks().filter(t => t.status === 'QUEUED' && this.store.db.prepare('SELECT task_id FROM preview_plans WHERE task_id=?').get(t.id)).map(t => ({ task: t, plan: this.plan(t.id) })).sort((a, b) => b.plan.priority - a.plan.priority || a.task.id.localeCompare(b.task.id));
      for (const { task, plan } of candidates) {
        if (task.dependencies.some(id => this.task(id).status !== 'DONE')) continue;
        if (active.reduce((n, p) => n + p.resourceUnits, 0) + plan.resourceUnits > this.config.maxResourceUnits) continue;
        if (active.some(p => p.worktreeId === plan.worktreeId || p.allowedPaths.some(a => plan.allowedPaths.some(b => overlap(a, b))))) continue;
        let grant: { id: string }; try { grant = this.grant(task.id); } catch { continue; }
        const lease = { taskId: task.id, runId: randomUUID(), token: randomUUID(), until: this.now() + this.config.leaseMs };
        this.store.db.prepare('INSERT INTO preview_leases VALUES(?,?,?,?,?)').run(lease.taskId, lease.runId, lease.token, lease.until, 'implement');
        this.event(task.id, 'task.claimed', {}, { policyDecisionId: grant.id, dependenciesSatisfied: true, lease: { runId: lease.runId, leaseUntil: new Date(lease.until).toISOString() } });
        this.event(task.id, 'task.started', {}, { lease: { runId: lease.runId, leaseUntil: new Date(lease.until).toISOString() } });
        this.audit(task.id, 'task.claimed', { runId: lease.runId, planDigest: digest(plan) }); return lease;
      }
      return;
    });
  }
  private check(lease: PreviewLease): LeaseRow {
    fields(lease, ['taskId', 'runId', 'token', 'until']); [lease.taskId, lease.runId, lease.token].forEach(label); bounded(lease.until, 0, Number.MAX_SAFE_INTEGER);
    const row = this.store.db.prepare('SELECT * FROM preview_leases WHERE task_id=?').get(lease.taskId) as unknown as LeaseRow | undefined;
    ensure(row && row.run_id === lease.runId && row.token === lease.token && row.until_ms === lease.until && row.until_ms > this.now(), 'Stale, expired, or forged preview lease');
    ensure(!['DONE', 'CANCELLED', 'QUARANTINED', 'FAILED'].includes(this.task(lease.taskId).status), 'Task no longer active'); this.grant(lease.taskId); return row;
  }
  private release(id: string): void { this.store.db.prepare('DELETE FROM preview_leases WHERE task_id=?').run(id); }
  cancel(id: string): void {
    this.store.transaction(() => { this.plan(id); this.event(id, 'task.cancelled', { reason: 'Host cancelled preview' }); this.release(id); this.audit(id, 'task.cancelled', {}); });
    this.controllers.get(id)?.abort();
  }
  private fail(lease: PreviewLease, reason: string, quarantine = false): void {
    this.store.transaction(() => {
      this.check(lease); const task = this.task(lease.taskId);
      this.event(task.id, quarantine ? 'task.quarantined' : 'task.failed', { reason }, task.status === 'RUNNING' ? { lease: { runId: lease.runId, leaseUntil: new Date(lease.until).toISOString() } } : {});
      this.release(task.id); this.audit(task.id, 'task.blocked', { reason, attempt: task.attempt, maxAttempts: task.maxAttempts });
      // Only a returned failed validation/review proves this local-only attempt
      // settled. Exceptions and interrupted callbacks must be reconciled explicitly.
      if (!quarantine && task.attempt < task.maxAttempts) this.event(task.id, 'task.retried', { reason: 'Bounded repair after settled independent check' }, { policyDecisionId: this.grant(task.id).id, sideEffectsReconciled: true });
    });
  }
  private reserve(lease: PreviewLease, stage: 'implement' | 'validate' | 'review'): void {
    this.store.transaction(() => {
      const row = this.check(lease); ensure(row.stage === stage, 'Callback stage already reserved or stale');
      const calls = Number(this.store.db.prepare("SELECT COUNT(*) AS n FROM preview_audit WHERE kind='callback.reserved'").get()?.n);
      if (calls >= this.config.maxInvocations) {
        this.event(lease.taskId, 'budget.exhausted', { reason: 'Offline callback invocation budget exhausted' }); this.release(lease.taskId); this.audit(lease.taskId, 'budget.exhausted', {}); return;
      }
      this.store.db.prepare('UPDATE preview_leases SET stage=? WHERE task_id=?').run(`${stage}:pending`, lease.taskId);
      this.audit(lease.taskId, 'callback.reserved', { runId: lease.runId, stage, costMicros: 0, mode: 'host-assisted-preview' });
    });
  }
  /** One attempt only. drain() automatically continues eligible dependents/repairs. */
  async run(lease: PreviewLease, callbacks: HostCallbacks): Promise<void> {
    const activeLease = this.check(lease); const plan = this.plan(lease.taskId); const controller = new AbortController();
    ensure(!this.controllers.has(lease.taskId), 'Attempt already running in this host'); this.controllers.set(lease.taskId, controller);
    const body = this.store.db.prepare('SELECT body_ref FROM preview_intake WHERE task_id=?').get(lease.taskId);
    const context = (): HostContext => ({ plan: structuredClone(plan), attempt: this.task(plan.taskId).attempt, operationId: lease.runId, untrustedBodyRef: String(body?.body_ref), signal: controller.signal });
    const timeout = setTimeout(() => controller.abort(), Math.max(1, activeLease.until_ms - this.now()));
    const invoke = async <T>(fn: () => Promise<T>): Promise<T> => {
      this.check(lease); ensure(!controller.signal.aborted, 'Callback cancelled');
      let onAbort: (() => void) | undefined;
      try { return await Promise.race([Promise.resolve().then(() => { this.check(lease); ensure(!controller.signal.aborted, 'Callback cancelled'); return fn(); }), new Promise<never>((_, reject) => { onAbort = () => reject(new Error('Callback cancelled or timed out')); controller.signal.addEventListener('abort', onAbort, { once: true }); })]); }
      finally { if (onAbort) controller.signal.removeEventListener('abort', onAbort); }
    };
    try {
      this.reserve(lease, 'implement'); const candidate = structuredClone(await invoke(() => callbacks.implement(context())));
      this.store.transaction(() => { this.check(lease); validateCandidate(candidate, plan); this.record(lease, 'implement', this.config.roles.coder, candidate); this.event(plan.taskId, 'task.validation_started', {}, { lease: { runId: lease.runId, leaseUntil: new Date(lease.until).toISOString() } }); this.stage(lease, 'validate'); });
      this.reserve(lease, 'validate'); const validation = structuredClone(await invoke(() => callbacks.validate(context(), structuredClone(candidate))));
      this.store.transaction(() => { this.check(lease); validateCheck(validation, candidate, plan); this.record(lease, 'validate', this.config.roles.validator, validation); });
      if (!validation.passed) { this.fail(lease, `Validation failed: ${validation.reportRef}`); return; }
      this.store.transaction(() => { this.check(lease); this.event(plan.taskId, 'task.validation_completed', { passed: true, reportId: validation.reportRef }); this.stage(lease, 'review'); });
      this.reserve(lease, 'review'); const review = structuredClone(await invoke(() => callbacks.review(context(), structuredClone(candidate), structuredClone(validation))));
      this.store.transaction(() => { this.check(lease); validateCheck(review, candidate, plan); this.record(lease, 'review', this.config.roles.reviewer, review); });
      if (!review.passed) { this.fail(lease, `Review failed: ${review.reportRef}`); return; }
      this.store.transaction(() => {
        this.check(lease); this.event(plan.taskId, 'task.review_completed', { passed: true, reportId: review.reportRef });
        const draft: DeliveryDraft = { schemaVersion: 1, mode: 'host-assisted-preview', taskId: plan.taskId, repo: this.config.repo, branch: `preview/${digest([this.config.repo, plan.taskId]).slice(0, 24)}`, commit: candidate.commit, artifactDigest: candidate.artifactDigest, title: plan.title, summary: candidate.summary, validationRef: validation.reportRef, reviewRef: review.reportRef, deliveryType: 'local_only', remoteWrites: false, mergeAllowed: false };
        this.store.db.prepare('INSERT INTO preview_drafts VALUES(?,?,?)').run(plan.taskId, digest(draft), canonical(draft));
        this.event(plan.taskId, 'task.pr_prepared', { deliveryRef: `draft:${digest(draft)}` });
        this.event(plan.taskId, 'task.finished', { deliveryType: 'local_only', deliveryRef: `draft:${digest(draft)}` }); this.release(plan.taskId); this.audit(plan.taskId, 'delivery.drafted', { draftDigest: digest(draft), remoteWrites: false });
      });
    } catch {
      // Never persist arbitrary exception strings: they may contain credentials.
      // Unknown callback effects cannot be safely replayed automatically.
      this.store.transaction(() => {
        const current = this.task(plan.taskId);
        const fence = this.store.db.prepare('SELECT run_id FROM preview_leases WHERE task_id=?').get(plan.taskId);
        if (fence?.run_id !== lease.runId) return;
        if (!['DONE', 'CANCELLED', 'FAILED', 'QUARANTINED'].includes(current.status)) {
          this.event(plan.taskId, 'task.quarantined', { reason: 'Callback failure, timeout, stale lease, or invalid evidence; host reconciliation required' }); this.release(plan.taskId);
          this.audit(plan.taskId, 'task.blocked', { reason: 'Unknown outcome or invalid contract', runId: lease.runId });
        }
      });
    } finally { clearTimeout(timeout); if (this.controllers.get(plan.taskId) === controller) this.controllers.delete(plan.taskId); }
  }
  private stage(lease: PreviewLease, stage: string): void { this.store.db.prepare('UPDATE preview_leases SET stage=? WHERE task_id=?').run(stage, lease.taskId); }
  private record(lease: PreviewLease, stage: string, role: string, value: unknown): void { this.store.db.prepare('INSERT INTO preview_evidence VALUES(?,?,?,?)').run(lease.runId, stage, role, canonical(value)); }
  /** Host must check effects first. Unknown outcomes are quarantined, never retried. */
  recoverExpired(taskId: string, observation: { outcome: 'no-effects' | 'unknown'; evidenceRef: string }): void {
    fields(observation, ['outcome', 'evidenceRef']); label(observation.evidenceRef); ensure(['no-effects', 'unknown'].includes(observation.outcome), 'Invalid recovery observation');
    this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT * FROM preview_leases WHERE task_id=?').get(taskId) as unknown as LeaseRow | undefined;
      ensure(row && row.until_ms <= this.now(), 'No expired lease'); const task = this.task(taskId);
      if (observation.outcome === 'unknown') this.event(taskId, 'task.quarantined', { reason: 'Host could not reconcile interrupted callback' });
      else if (task.status === 'RUNNING' || task.status === 'CLAIMED') this.event(taskId, 'task.lease_recovered', {}, { sideEffectsReconciled: true });
      else {
        this.event(taskId, 'task.failed', { reason: 'Interrupted independent check reconciled by host' });
        if (task.attempt < task.maxAttempts) this.event(taskId, 'task.retried', {}, { policyDecisionId: this.grant(taskId).id, sideEffectsReconciled: true });
      }
      this.release(taskId); this.audit(taskId, 'task.reconciled', observation);
    });
  }
  async drain(callbacks: HostCallbacks): Promise<number> {
    let count = 0;
    while (true) {
      const batch: PreviewLease[] = []; let lease: PreviewLease | undefined;
      while ((lease = this.claim())) batch.push(lease);
      if (!batch.length) return count;
      await Promise.all(batch.map(l => this.run(l, callbacks))); count += batch.length;
    }
  }
  draft(taskId: string): DeliveryDraft | undefined { const row = this.store.db.prepare('SELECT * FROM preview_drafts WHERE task_id=?').get(taskId); if (!row) return; const draft = JSON.parse(String(row.json)) as DeliveryDraft; ensure(digest(draft) === row.digest, 'Draft corruption'); return draft; }
  /** Pure local ledger reconciliation. This never queries or writes GitHub. A trusted
   * connector must supply an observation; unknown never becomes permission to retry. */
  reconcileDelivery(taskId: string, observation: DeliveryObservation): 'draft-only' | 'confirmed-existing' | 'blocked' {
    label(observation.evidenceRef); const draft = this.draft(taskId); ensure(draft, 'No accepted local draft');
    if (observation.state === 'found') { fields(observation, ['state', 'evidenceRef', 'repo', 'branch', 'commit', 'prRef']); label(observation.prRef); ensure(observation.repo === draft.repo && observation.branch === draft.branch && observation.commit === draft.commit, 'Remote observation scope mismatch'); }
    else { fields(observation, ['state', 'evidenceRef']); ensure(observation.state === 'absent' || observation.state === 'unknown', 'Invalid delivery observation'); }
    return this.store.transaction(() => {
      const prior = this.store.db.prepare('SELECT * FROM preview_delivery WHERE task_id=?').get(taskId);
      if (prior?.state === 'found') {
        const previous = JSON.parse(String(prior.json)) as DeliveryObservation;
        ensure(observation.state === 'found' && previous.state === 'found' && observation.prRef === previous.prRef, 'Confirmed delivery cannot be replaced or downgraded'); return 'confirmed-existing';
      }
      this.store.db.prepare('INSERT INTO preview_delivery VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET state=excluded.state,json=excluded.json').run(taskId, observation.state, canonical(observation));
      this.audit(taskId, 'delivery.reconciled', observation);
      return observation.state === 'found' ? 'confirmed-existing' : observation.state === 'absent' ? 'draft-only' : 'blocked';
    });
  }
}
