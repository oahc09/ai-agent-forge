import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CandidateWorkspace } from '../../packages/execution/src/candidate-workspace.ts';
import { checkG2SingleTaskPilot, G2_OFFLINE_FIXTURE } from '../../packages/execution/src/g2-pilot.ts';

const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const fixture = G2_OFFLINE_FIXTURE;
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'forge-g2-offline-'));
  roots.push(root);
  const identity = { leaseId: 'lease-1', taskId: fixture.id, workerId: 'worker-1', commit: 'a'.repeat(40) };
  const workspace = new CandidateWorkspace(root, identity, [{ path: fixture.path, mode: 0o644, bytes: Buffer.from(fixture.source) }]);
  writeFileSync(join(workspace.directory, fixture.path), fixture.source.replace('=== 1', '=== 0'));
  const inventory = workspace.inspect();
  const shared = { taskId: identity.taskId, workerId: identity.workerId, leaseId: identity.leaseId,
    sourceCommit: identity.commit, runId: 'run-1', candidateDigest: inventory.candidateDigest, classification: 'offline-fixture' };
  const runner = { ...shared, schema: 'forge.g2-offline-runner.v1', issuerId: 'runner-1', baselineDigest: inventory.baselineDigest, exitCode: 0 };
  const runnerRaw = JSON.stringify(runner);
  const independent = { ...shared, schema: 'forge.g2-offline-independent.v1', issuerId: 'verifier-1',
    runnerReceiptSha256: digest(runnerRaw), result: 'fixture-bytes-match' };
  const independentRaw = JSON.stringify(independent);
  const host = { identity, runId: shared.runId, runner: { issuerId: runner.issuerId, receiptSha256: digest(runnerRaw) },
    independent: { issuerId: independent.issuerId, receiptSha256: digest(independentRaw) } };
  return { host, inventory, runner, runnerRaw, independent, independentRaw, workspace };
}
describe('G2 offline single-task receipt preflight', () => {
  it('uses the real CandidateWorkspace to bind an exact deterministic edit without claiming a gate', () => {
    const f = setup();
    expect(checkG2SingleTaskPilot(f.host, f.inventory, f.runnerRaw, f.independentRaw)).toEqual({
      status: 'OFFLINE_CONSISTENT', gateG2: 'NOT_VERIFIED', gateG8: 'NOT_VERIFIED',
      authorizesExecution: false, verifiedRealExecutor: false,
    });
  });
  it('blocks self-consistent receipts without separately supplied trusted bindings', () => {
    const f = setup();
    expect(checkG2SingleTaskPilot(undefined, f.inventory, f.runnerRaw, f.independentRaw).status).toBe('BLOCKED_NO_TRUSTED_BINDINGS');
  });
  it('rejects tampering without the original digest and replays under a different host run', () => {
    const f = setup();
    expect(checkG2SingleTaskPilot(f.host, f.inventory, JSON.stringify({...f.runner, exitCode: 1}), f.independentRaw).status).toBe('REJECTED');
    f.host.runId = 'run-2';
    expect(checkG2SingleTaskPilot(f.host, f.inventory, f.runnerRaw, f.independentRaw).status).toBe('REJECTED');
  });
  it.each([
    { runId: 'run-2' }, { leaseId: 'lease-2' }, { sourceCommit: 'b'.repeat(40) }, { workerId: 'worker-2' },
    { candidateDigest: 'b'.repeat(64) }, { runnerReceiptSha256: 'c'.repeat(64) }, { issuerId: 'runner-1' },
    { classification: 'provider-real' }, { result: 'sandbox-verified' }, { verifiedRealExecutor: true },
  ])('rejects independently rehashed inconsistent or over-claiming verifier payload %j', (change) => {
    const f = setup();
    const raw = JSON.stringify({...f.independent, ...change});
    f.host.independent.receiptSha256 = digest(raw);
    expect(checkG2SingleTaskPilot(f.host, f.inventory, f.runnerRaw, raw).status).toBe('REJECTED');
  });
  it.each(['duplicate', 'oversize', 'unknown-runner-key', 'failed-exit'])('rejects a pinned %s runner payload', (scenario) => {
    const f = setup();
    let raw = JSON.stringify({...f.runner, extra: true});
    if (scenario === 'duplicate') raw = '{"schema":"not-real",' + f.runnerRaw.slice(1);
    if (scenario === 'oversize') raw = JSON.stringify({...f.runner, classification: 'x'.repeat(4096)});
    if (scenario === 'failed-exit') raw = JSON.stringify({...f.runner, exitCode: 1});
    f.host.runner.receiptSha256 = digest(raw);
    const independent = JSON.stringify({...f.independent, runnerReceiptSha256: digest(raw)});
    f.host.independent.receiptSha256 = digest(independent);
    expect(checkG2SingleTaskPilot(f.host, f.inventory, raw, independent).status).toBe('REJECTED');
  });
  it('rejects the worker or runner as the independent issuer even with matching pins', () => {
    for (const issuerId of ['worker-1', 'runner-1']) {
      const f = setup();
      const raw = JSON.stringify({...f.independent, issuerId});
      f.host.independent = { issuerId, receiptSha256: digest(raw) };
      expect(checkG2SingleTaskPilot(f.host, f.inventory, f.runnerRaw, raw).status).toBe('REJECTED');
    }
  });
  it('rejects extra files and arbitrary code without executing candidate content', () => {
    const f = setup();
    writeFileSync(join(f.workspace.directory, 'unexpected.ts'), 'throw new Error("never executed");\n');
    const extra = f.workspace.inspect();
    expect(checkG2SingleTaskPilot(f.host, extra, f.runnerRaw, f.independentRaw).status).toBe('REJECTED');
    const changed = setup();
    writeFileSync(join(changed.workspace.directory, G2_OFFLINE_FIXTURE.path), 'throw new Error("never executed");\n');
    expect(checkG2SingleTaskPilot(changed.host, changed.workspace.inspect(), changed.runnerRaw, changed.independentRaw).status).toBe('REJECTED');
  });
  it('does not evaluate accessors in nested candidate inventory', () => {
    const f = setup();
    let invoked = false;
    Object.defineProperty(f.inventory.files[0], 'sha256', { get() { invoked = true; return '1'.repeat(64); } });
    expect(checkG2SingleTaskPilot(f.host, f.inventory, f.runnerRaw, f.independentRaw).status).toBe('REJECTED');
    expect(invoked).toBe(false);
  });
});
