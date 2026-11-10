import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { readinessReport } from '../../apps/cli/src/readiness.ts';

it('never upgrades readiness when every executable is present and never executes them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-readiness-'));
  const marker = join(dir, 'executed');
  try {
    for (const name of ['codex', 'opencode', 'pi', 'bwrap']) {
      writeFileSync(join(dir, name), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    }
    const report = readinessReport(dir);
    expect(report.inventory.every(item => item.availability === 'PRESENT')).toBe(true);
    expect(report.inventory.every(item => !item.executionVerified && item.version === 'NOT_INSPECTED')).toBe(true);
    expect(report.productionReady).toBe(false);
    expect(report.gate.status).toBe('NOT_VERIFIED');
    expect(report.sandbox).toEqual({ status: 'NOT_PROBED', isolationVerified: false });
    expect(report.providerAccess).toBe('NOT_INSPECTED');
    expect(report.providerCost).toBe('NOT_MEASURED');
    expect(report.blockers.map(item => item.id)).toEqual(['REAL_ADAPTERS', 'PROVIDER_AUTHORIZATION', 'OS_ISOLATION', 'REAL_EVIDENCE']);
    expect(existsSync(marker)).toBe(false);
    expect(JSON.stringify(report)).not.toContain(dir);
  } finally { rmSync(dir, { recursive: true }); }
});
it('does not confuse directories, broken links or non-executable files with executors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-readiness-'));
  try {
    mkdirSync(join(dir, 'codex'));
    symlinkSync(join(dir, 'absent'), join(dir, 'opencode'));
    writeFileSync(join(dir, 'pi'), 'not executable', { mode: 0o600 });
    const items = readinessReport(dir).inventory;
    expect(items.map(item => item.availability)).toEqual(['NOT_FOUND', 'NOT_FOUND', 'UNKNOWN', 'NOT_FOUND']);
  } finally { rmSync(dir, { recursive: true }); }
});
it('ignores empty and relative PATH entries, and needs no configured state', () => {
  expect(readinessReport(['', '.', 'relative', ''].join(delimiter)).inventory.every(item => item.availability === 'NOT_FOUND')).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), 'forge-readiness-'));
  try {
    const state = join(dir, 'never-created');
    const call = (...args: string[]) => spawnSync(process.execPath, ['apps/cli/src/index.ts', ...args], {
      encoding: 'utf8', env: { PATH: '' },
    });
    const result = call('doctor', '--readiness', '--state-dir', state, '--json');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).mode).toBe('read-only-inventory');
    expect(existsSync(state)).toBe(false);
    expect(call('doctor', 'missing-policy.json', '--readiness').status).toBe(1);
    expect(call('doctor', '--readiness', '--execute').status).toBe(1);
  } finally { rmSync(dir, { recursive: true }); }
});
