import schema from '../schemas/agent-input.schema.json' with { type: 'json' };

/** Offline protocol only. Permissions are declarations, not an OS sandbox or grants. */
export interface ContextScope { repo: string; branch: string; taskId: string; sourceVersion: string }
export interface ReadOnlyReference { id: string; uri: string; sha256: string; readOnly: true }
export interface ContextFact { id: string; text: string; classification: 'verified' | 'inferred'; evidenceRefs: string[] }
export interface HandoffCapsule {
  schemaVersion: 1; id: string; scope: ContextScope; goal: string; facts: ContextFact[];
  references: ReadOnlyReference[]; changedCommits: string[]; failedExperiments: string[];
  openQuestions: string[]; nextSteps: string[]; confidentiality: 'public' | 'internal';
  createdAt: string; expiresAt: string; acceptedBy: string;
}
export interface AgentRunInput {
  schemaVersion: 1; taskId: string; runId: string; purpose: string; scope: ContextScope;
  readOnlyRefs: ReadOnlyReference[];
  permissions: { policyDecisionId: string; commands: { executable: string; args: string[] }[]; networkDomains: string[]; readPaths: string[]; writePaths: string[] };
  budget: { id: string; maxTokens: number; maxCalls: number; maxCostMicros: number; timeoutMs: number };
  cwd: string; capsule: HandoffCapsule | null; trace: { traceId: string; spanId: string };
  /** Opaque policy lookup reference. Never a bearer token, password, or credential. */
  approvalRef: string; attempt: number;
}
interface EventBase { schemaVersion: 1; taskId: string; runId: string; sequence: number; occurredAt: string }
export type AgentRunEvent = EventBase & (
  { type: 'status'; status: 'running' | 'succeeded' | 'cancelled' } |
  { type: 'output'; text: string } |
  { type: 'failure'; status: 'failed'; code: 'TIMEOUT' | 'ADAPTER_FAILURE' | 'CONTEXT_MISSING'; retryable: boolean }
);
export interface AgentCheckpoint {
  schemaVersion: 1; taskId: string; runId: string; adapterId: string; scope: ContextScope;
  createdAt: string; expiresAt: string; capsule: HandoffCapsule; lastSequence: number;
  recovery: 'new-session-with-summary';
}
export interface AgentAdapter {
  id: string;
  capabilities(): Promise<{ streaming: boolean; resume: boolean; cancellation: boolean; toolCalls: boolean; contextHandoff: 'summary' | 'native' | 'none' }>;
  start(input: AgentRunInput, signal: AbortSignal): AsyncIterable<AgentRunEvent>;
  cancel(runId: string): Promise<void>;
  resume?(checkpoint: AgentCheckpoint, signal: AbortSignal): AsyncIterable<AgentRunEvent>;
}
export class AdapterContractError extends Error {
  constructor(message: string) { super(message); this.name = 'AdapterContractError'; }
}
function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AdapterContractError(message);
}
type Schema = { $ref?: string; anyOf?: Schema[]; const?: unknown; enum?: unknown[]; type?: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; items?: Schema; maxItems?: number; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string; format?: string };
const definitions = schema.$defs as unknown as Record<string, Schema>;
/** Deliberately small evaluator for the checked-in schemas, with no coercion/defaults. */
function validate(value: unknown, rule: Schema, path: string): void {
  if (rule.$ref) { const child = definitions[rule.$ref.replace('#/$defs/', '')]; requireThat(child, 'Unknown schema reference'); return validate(value, child, path); }
  if (rule.anyOf) {
    requireThat(rule.anyOf.some(child => { try { validate(value, child, path); return true; } catch { return false; } }), `Invalid union at ${path}`); return;
  }
  if ('const' in rule) requireThat(value === rule.const, `Invalid constant at ${path}`);
  if (rule.enum) requireThat(rule.enum.includes(value), `Invalid enum at ${path}`);
  if (rule.type === 'null') requireThat(value === null, `Expected null at ${path}`);
  if (rule.type === 'boolean') requireThat(typeof value === 'boolean', `Expected boolean at ${path}`);
  if (rule.type === 'integer') requireThat(Number.isSafeInteger(value) && (value as number) >= rule.minimum! && (value as number) <= rule.maximum!, `Invalid integer at ${path}`);
  if (rule.type === 'string') {
    requireThat(typeof value === 'string' && value.trim().length > 0, `Expected text at ${path}`);
    if (rule.minLength !== undefined) requireThat(value.length >= rule.minLength, `Short text at ${path}`);
    if (rule.maxLength !== undefined) requireThat(value.length <= rule.maxLength, `Long text at ${path}`);
    if (rule.pattern) requireThat(new RegExp(rule.pattern).test(value), `Invalid text at ${path}`);
    if (rule.format === 'date-time') requireThat(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, `Invalid timestamp at ${path}`);
    requireThat(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), `Control characters at ${path}`);
    // Defense in depth, not a claim of general-purpose secret detection.
    requireThat(!/(?:-----BEGIN .*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,})|\b(?:password|api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*\S+|\bBearer\s+\S+)/i.test(value), `Credential-like content at ${path}`);
  }
  if (rule.type === 'array') {
    requireThat(Array.isArray(value) && value.length <= rule.maxItems!, `Invalid array at ${path}`);
    for (const [i, item] of value.entries()) validate(item, rule.items!, `${path}[${i}]`);
  }
  if (rule.type === 'object') {
    requireThat(typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype, `Expected plain object at ${path}`);
    const record = value as Record<string, unknown>;
    requireThat(Reflect.ownKeys(record).every(key => typeof key === 'string' && Object.hasOwn(rule.properties!, key)), `Unknown field at ${path}`);
    for (const key of rule.required!) { requireThat(Object.hasOwn(record, key), `Missing ${path}.${key}`); validate(record[key], rule.properties![key]!, `${path}.${key}`); }
  }
}
function checkSchema(value: unknown, name: string): void { validate(value, definitions[name]!, name); }
function validTime(now: number): void { requireThat(Number.isSafeInteger(now) && now >= 0, 'Invalid clock'); }
export function sameScope(a: ContextScope, b: ContextScope): boolean { return a.repo === b.repo && a.branch === b.branch && a.taskId === b.taskId && a.sourceVersion === b.sourceVersion; }
export function validateContextScope(value: unknown): asserts value is ContextScope { checkSchema(value, 'scope'); }
function references(refs: ReadOnlyReference[]): void {
  requireThat(new Set(refs.map(r => r.id)).size === refs.length, 'Duplicate reference');
  for (const ref of refs) requireThat(/^(artifact|repo|evidence):[A-Za-z0-9._/-]+$/.test(ref.uri) && !ref.uri.split(/[/:]/).includes('..'), 'Reference must be an opaque read-only local reference');
}
export function validateHandoffCapsule(value: unknown, now = Date.now()): asserts value is HandoffCapsule {
  validTime(now); checkSchema(value, 'capsule'); const capsule = value as HandoffCapsule;
  requireThat(Date.parse(capsule.createdAt) <= now && Date.parse(capsule.createdAt) < Date.parse(capsule.expiresAt) && now < Date.parse(capsule.expiresAt), 'Capsule expired or not yet valid');
  references(capsule.references);
  requireThat(new Set(capsule.facts.map(f => f.id)).size === capsule.facts.length, 'Duplicate fact');
  const ids = new Set(capsule.references.map(r => r.id));
  for (const fact of capsule.facts) {
    requireThat(new Set(fact.evidenceRefs).size === fact.evidenceRefs.length && fact.evidenceRefs.every(id => ids.has(id)), 'Missing/duplicate evidence reference');
    requireThat(fact.classification !== 'verified' || fact.evidenceRefs.length > 0, 'Verified facts require evidence');
  }
}
export function validateAgentRunInput(value: unknown, now = Date.now()): asserts value is AgentRunInput {
  validTime(now); checkSchema(value, 'input'); const input = value as AgentRunInput;
  requireThat(input.taskId === input.scope.taskId, 'Task scope mismatch'); references(input.readOnlyRefs);
  for (const path of [input.cwd, ...input.permissions.readPaths, ...input.permissions.writePaths]) requireThat(!path.split('/').some(p => p === '.' || p === '..'), 'Noncanonical path');
  if (input.capsule) { validateHandoffCapsule(input.capsule, now); requireThat(sameScope(input.scope, input.capsule.scope), 'Capsule scope mismatch'); }
}
export function validateAgentRunEvent(value: unknown): asserts value is AgentRunEvent { checkSchema(value, 'event'); }
export function validateAgentCheckpoint(value: unknown, now = Date.now()): asserts value is AgentCheckpoint {
  validTime(now); checkSchema(value, 'checkpoint'); const checkpoint = value as AgentCheckpoint;
  validateHandoffCapsule(checkpoint.capsule, now);
  requireThat(checkpoint.taskId === checkpoint.scope.taskId && sameScope(checkpoint.scope, checkpoint.capsule.scope), 'Checkpoint scope mismatch');
  requireThat(Date.parse(checkpoint.createdAt) <= now && Date.parse(checkpoint.createdAt) < Date.parse(checkpoint.expiresAt) && now < Date.parse(checkpoint.expiresAt) && Date.parse(checkpoint.expiresAt) <= Date.parse(checkpoint.capsule.expiresAt), 'Invalid checkpoint lifetime');
}
/** Transport validator: prevents status spoofing, sequence gaps, run mixing, and post-terminal output. */
export class AgentEventStreamValidator {
  private sequence = 0;
  private phase: 'new' | 'running' | 'terminal' = 'new';
  private taskId: string;
  private runId: string;
  constructor(taskId: string, runId: string) { checkSchema(taskId, 'id'); checkSchema(runId, 'id'); this.taskId = taskId; this.runId = runId; }
  accept(value: unknown): asserts value is AgentRunEvent {
    validateAgentRunEvent(value);
    requireThat(value.taskId === this.taskId && value.runId === this.runId && value.sequence === this.sequence + 1, 'Event identity or sequence mismatch');
    requireThat(this.phase !== 'terminal', 'Event after terminal status');
    if (this.phase === 'new') requireThat(value.type === 'status' && (value.status === 'running' || value.status === 'cancelled'), 'Stream must start with running/cancelled');
    else requireThat(!(value.type === 'status' && value.status === 'running'), 'Duplicate running status');
    if (value.type === 'failure' || (value.type === 'status' && value.status !== 'running')) this.phase = 'terminal'; else this.phase = 'running';
    this.sequence = value.sequence;
  }
  finish(): void { requireThat(this.phase === 'terminal', 'Stream ended without terminal event'); }
}
