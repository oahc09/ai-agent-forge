import { createHash } from 'node:crypto';
export class PreviewError extends Error {}
export function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new PreviewError(message); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function fields(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, 'Plain object required');
  ensure(Reflect.ownKeys(value).length === names.length && names.every(n => Object.hasOwn(value, n)), 'Unexpected or missing fields');
}
export function label(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value) && !value.split('/').includes('..'), 'Invalid opaque label');
}
export function bounded(value: unknown, min: number, max: number): asserts value is number { ensure(Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max, 'Invalid bounded integer'); }
export function text(value: unknown): asserts value is string { ensure(typeof value === 'string' && value.trim().length > 0 && value.length <= 2000 && !/(?:-----BEGIN .*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,})|\b(?:password|api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*\S+|\bBearer\s+\S+)/i.test(value) && !/[\x00-\x1f]/.test(value), 'Invalid text'); }
export function path(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) && value.length < 300 && !value.endsWith('/') && !value.split('/').some(p => !p || p === '.' || p === '..'), 'Noncanonical relative path');
}
export function overlap(a: string, b: string): boolean { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
export const protectedRoots = ['packages/policy', 'packages/validator', 'packages/event-store', 'packages/domain', 'packages/scheduler', 'configs', '.github', 'benchmarks/hidden', 'AGENTS.md'];
export interface IntakeMetadata { kind: 'issue' | 'ci' | 'manual' | 'schedule'; repo: string; actor: string; labels: string[]; externalEventId: string; actionVersion: string }
export interface TaskPlan {
  taskId: string; title: string; goal: string; inputs: string[]; nonGoals: string[]; dependencies: string[];
  allowedPaths: string[]; acceptanceIds: string[]; rollback: string; risk: 'low'; priority: number; resourceUnits: number; worktreeId: string; maxAttempts: number;
}
export interface Candidate { commit: string; artifactDigest: string; changedPaths: string[]; summary: string }
export interface CheckResult { passed: boolean; reportRef: string; artifactDigest: string; acceptanceIds: string[] }
export interface PreviewConfig {
  repo: string; actors: string[]; labels: string[]; sourceKinds: IntakeMetadata['kind'][];
  maxConcurrent: number; maxResourceUnits: number; maxAttempts: number; maxInvocations: number; leaseMs: number;
  roles: { coder: string; validator: string; reviewer: string }; policy: unknown;
}
export function validatePlan(value: unknown): asserts value is TaskPlan {
  fields(value, ['taskId', 'title', 'goal', 'inputs', 'nonGoals', 'dependencies', 'allowedPaths', 'acceptanceIds', 'rollback', 'risk', 'priority', 'resourceUnits', 'worktreeId', 'maxAttempts']);
  label(value.taskId); label(value.worktreeId); for (const key of ['title', 'goal', 'rollback']) text(value[key]);
  for (const key of ['inputs', 'nonGoals', 'dependencies', 'allowedPaths', 'acceptanceIds']) {
    const arr = value[key]; ensure(Array.isArray(arr) && arr.length <= 100 && new Set(arr).size === arr.length, 'Invalid plan array');
    for (const entry of arr) { if (key === 'allowedPaths') path(entry); else label(entry); }
  }
  ensure((value.allowedPaths as string[]).length > 0 && (value.acceptanceIds as string[]).length > 0, 'Paths and fixed acceptance required');
  ensure(!(value.allowedPaths as string[]).some(p => protectedRoots.some(root => overlap(p, root))), 'Protected path requested');
  ensure(value.risk === 'low' && !(value.dependencies as string[]).includes(value.taskId as string), 'Only low-risk non-self-dependent preview plans');
  bounded(value.priority, 0, 100); bounded(value.resourceUnits, 1, 100); bounded(value.maxAttempts, 1, 3);
}
export function validatePlanGraph(plans: TaskPlan[]): void {
  const byId = new Map<string, TaskPlan>();
  for (const plan of plans) { validatePlan(plan); ensure(!byId.has(plan.taskId), 'Duplicate task'); byId.set(plan.taskId, plan); }
  const done = new Set<string>(); const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) return;
    ensure(!visiting.has(id), 'Dependency cycle'); const plan = byId.get(id); ensure(plan, 'Unknown dependency'); visiting.add(id);
    for (const dep of plan.dependencies) visit(dep);
    visiting.delete(id); done.add(id);
  };
  for (const id of byId.keys()) visit(id);
}
export function validateCandidate(value: unknown, plan: TaskPlan): asserts value is Candidate {
  fields(value, ['commit', 'artifactDigest', 'changedPaths', 'summary']);
  ensure(typeof value.commit === 'string' && /^[a-f0-9]{40}$/.test(value.commit), 'Candidate commit required');
  ensure(typeof value.artifactDigest === 'string' && /^[a-f0-9]{64}$/.test(value.artifactDigest), 'Artifact digest required');
  text(value.summary); ensure(Array.isArray(value.changedPaths) && value.changedPaths.length > 0 && value.changedPaths.length <= 100, 'Changed paths required');
  ensure(new Set(value.changedPaths).size === value.changedPaths.length, 'Duplicate changed path');
  for (const changed of value.changedPaths) { path(changed); ensure(plan.allowedPaths.some(p => changed === p || changed.startsWith(`${p}/`)) && !protectedRoots.some(p => overlap(changed, p)), 'Candidate path outside grant'); }
}
export function validateCheck(value: unknown, candidate: Candidate, plan: TaskPlan): asserts value is CheckResult {
  fields(value, ['passed', 'reportRef', 'artifactDigest', 'acceptanceIds']); label(value.reportRef);
  ensure(typeof value.passed === 'boolean' && value.artifactDigest === candidate.artifactDigest, 'Validation must bind exact candidate artifact');
  ensure(Array.isArray(value.acceptanceIds) && canonical([...value.acceptanceIds].sort()) === canonical([...plan.acceptanceIds].sort()), 'Acceptance cannot be changed by candidate');
}
