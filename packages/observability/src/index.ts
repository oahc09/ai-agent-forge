import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
export interface Check { name: string; passed: boolean; evidencePath: string }
export interface ValidationReport {
  schemaVersion: 1; runId: string; taskId: string; evaluatedCommit: string;
  benchmarkVersion: string; environmentDigest: string; passed: boolean;
  checks: Check[]; artifactHashes: Record<string,string>; generatedAt: string;
  evidenceKind: 'offline-fixture'; productClaim: 'NOT_VERIFIED';
}
export function sha256(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
export function createReport(input: Omit<ValidationReport,'schemaVersion'|'passed'|'generatedAt'|'evidenceKind'|'productClaim'>): ValidationReport {
  for (const key of ['runId','taskId','benchmarkVersion','environmentDigest'] as const) {
    if (!input[key].trim()) throw new Error(`Missing ${key}`);
  }
  if (!/^[a-f0-9]{40}$/.test(input.evaluatedCommit)) throw new Error('Full evaluated commit required');
  if (!/^[a-f0-9]{64}$/.test(input.environmentDigest)) throw new Error('Environment digest must be SHA-256');
  if (input.checks.length === 0) throw new Error('Empty validation is not a pass');
  for (const check of input.checks) {
    if (typeof check.passed !== 'boolean') throw new Error('Check outcome must be boolean');
    if (!check.name.trim() || !check.evidencePath.trim() || !/^[a-f0-9]{64}$/.test(input.artifactHashes[check.evidencePath] ?? '')) throw new Error('Every check requires hashed evidence');
  }
  return {...structuredClone(input), schemaVersion:1, passed:input.checks.every(c=>c.passed),
    generatedAt:new Date().toISOString(), evidenceKind:'offline-fixture', productClaim:'NOT_VERIFIED'};
}
export function writeReportExclusive(path: string, report: ValidationReport): void {
  writeFileSync(path, JSON.stringify(report,null,2)+'\n', {flag:'wx',mode:0o600});
}
