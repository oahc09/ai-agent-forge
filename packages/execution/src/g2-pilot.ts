import { createHash } from 'node:crypto';
import type { CandidateIdentity, CandidateInventory } from './candidate-workspace.ts';

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const fixturePath = 'src/is-even.ts';
const source = 'export const isEven = (n: number): boolean => n % 2 === 1;\n';
const expected = 'export const isEven = (n: number): boolean => n % 2 === 0;\n';
export const G2_OFFLINE_FIXTURE = Object.freeze({
  id: 'g2-single-task-is-even-v1', path: fixturePath, source,
  sourceSha256: digest(source), expectedSha256: digest(expected),
});
const safety = { gateG2: 'NOT_VERIFIED', gateG8: 'NOT_VERIFIED', authorizesExecution: false, verifiedRealExecutor: false } as const;
type Result = typeof safety & { status: 'BLOCKED_NO_TRUSTED_BINDINGS' | 'REJECTED' | 'OFFLINE_CONSISTENT' };
type Pin = Readonly<{ issuerId: string; receiptSha256: string }>;
/** Supplied out-of-band by the trusted host; never populate from receipt/candidate claims.
 * Pin consistency is not an OS proof, approval, provider authorization or attestation of key custody. */
export interface G2HostBindings {
  readonly identity: CandidateIdentity;
  readonly runId: string;
  readonly runner: Pin;
  readonly independent: Pin;
}
class InvalidPilot extends Error {}
function ensure(value: unknown): asserts value { if (!value) throw new InvalidPilot(); }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  ensure(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
  const entries = Object.getOwnPropertyDescriptors(value);
  ensure(Reflect.ownKeys(entries).length === keys.length);
  const result: Record<string, unknown> = {};
  for (const key of keys) { const prop = entries[key]; ensure(prop && prop.enumerable && 'value' in prop); result[key] = prop.value; }
  return result;
}
const roleId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value);
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function exact(value: unknown, expected: unknown): void {
  if (!expected || typeof expected !== 'object') { ensure(value === expected); return; }
  if (Array.isArray(expected)) {
    ensure(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length === expected.length);
    ensure(Reflect.ownKeys(value).length === expected.length + 1);
    for (const [index, item] of expected.entries()) {
      const prop = Object.getOwnPropertyDescriptor(value, String(index));
      ensure(prop && 'value' in prop);
      exact(prop.value, item);
    }
    return;
  }
  const record = expected as Record<string, unknown>;
  const actual = fields(value, Object.keys(record));
  for (const [key, item] of Object.entries(record)) exact(actual[key], item);
}
function parseBoundReceipt(raw: unknown, pin: Pin, keys: string[]): Record<string, unknown> {
  ensure(typeof raw === 'string' && raw.length <= 4096 && Buffer.byteLength(raw) <= 4096 && digest(raw) === pin.receiptSha256);
  const parsed: unknown = JSON.parse(raw);
  // Exact compact encoding prevents duplicate field aliases or trailing content.
  ensure(JSON.stringify(parsed) === raw);
  return fields(parsed, keys);
}
const shared = ['schema', 'issuerId', 'taskId', 'leaseId', 'workerId', 'sourceCommit', 'runId', 'candidateDigest'];
/** Pure offline validation only. Accepts the independent validated candidate inventory from
 * CandidateWorkspace.inspect after the runner stops, not a worker report. No filesystem or process access. */
export function checkG2SingleTaskPilot(host: G2HostBindings | undefined, inventory: CandidateInventory,
  runnerRaw: unknown, independentRaw: unknown): Result {
  if (host === undefined) return { ...safety, status: 'BLOCKED_NO_TRUSTED_BINDINGS' };
  try {
    const binding = fields(host, ['identity', 'runId', 'runner', 'independent']);
    const identity = fields(binding.identity, ['leaseId', 'taskId', 'workerId', 'commit']);
    const runnerPin = fields(binding.runner, ['issuerId', 'receiptSha256']);
    const independentPin = fields(binding.independent, ['issuerId', 'receiptSha256']);
    const { taskId, leaseId, workerId, commit } = identity;
    const runId = binding.runId;
    ensure(taskId === G2_OFFLINE_FIXTURE.id && roleId(leaseId) && roleId(workerId) && roleId(runId));
    ensure(typeof commit === 'string' && /^[a-f0-9]{40}$/.test(commit));
    const rId = runnerPin.issuerId; const iId = independentPin.issuerId;
    const rSha = runnerPin.receiptSha256; const iSha = independentPin.receiptSha256;
    ensure(roleId(rId) && roleId(iId) && rId !== iId && rId !== workerId && iId !== workerId);
    ensure(sha256(rSha) && sha256(iSha) && rSha !== iSha);
    const candidate = fields(inventory, ['identity', 'baselineDigest', 'candidateDigest', 'files', 'directories',
      'changes', 'isolationVerified', 'applied']);
    const candidateIdentity = fields(candidate.identity, ['leaseId', 'taskId', 'workerId', 'commit']);
    exact(candidateIdentity, identity);
    ensure(candidate.isolationVerified === false && candidate.applied === false);
    const before = { path: fixturePath, mode: 0o644, size: Buffer.byteLength(source), sha256: G2_OFFLINE_FIXTURE.sourceSha256 };
    const after = { path: fixturePath, size: Buffer.byteLength(expected), mode: 0o644, sha256: G2_OFFLINE_FIXTURE.expectedSha256 };
    const files = [after]; const directories = ['src'];
    // inspect hashes the original identity's order. Only host-supplied own data properties are allowed.
    const rawIdentity = Object.fromEntries(Object.keys(candidate.identity as object).map(key => [key, candidateIdentity[key]]));
    const baselineDigest = digest(JSON.stringify({ identity: rawIdentity, files: [before] }));
    const candidateDigest = digest(JSON.stringify({ identity: rawIdentity, files, directories }));
    ensure(candidate.baselineDigest === baselineDigest && candidate.candidateDigest === candidateDigest);
    exact(candidate.files, files);
    exact(candidate.directories, directories);
    exact(candidate.changes, [{ path: fixturePath, kind: 'modified', before, after }]);

    const runner = parseBoundReceipt(runnerRaw, { issuerId: rId, receiptSha256: rSha },
      [...shared, 'baselineDigest', 'classification', 'exitCode']);
    const independent = parseBoundReceipt(independentRaw, { issuerId: iId, receiptSha256: iSha },
      [...shared, 'runnerReceiptSha256', 'classification', 'result']);
    for (const receipt of [runner, independent]) {
      ensure(receipt.taskId === taskId && receipt.leaseId === leaseId && receipt.workerId === workerId
        && receipt.sourceCommit === commit && receipt.runId === runId && receipt.candidateDigest === candidateDigest);
      ensure(receipt.classification === 'offline-fixture');
    }
    ensure(runner.schema === 'forge.g2-offline-runner.v1' && runner.issuerId === rId
      && runner.baselineDigest === baselineDigest && runner.exitCode === 0);
    ensure(independent.schema === 'forge.g2-offline-independent.v1' && independent.issuerId === iId
      && independent.runnerReceiptSha256 === rSha && independent.result === 'fixture-bytes-match');
    return { ...safety, status: 'OFFLINE_CONSISTENT' };
  } catch {
    return { ...safety, status: 'REJECTED' };
  }
}
