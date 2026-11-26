import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdapterContractError } from '../../execution/src/index.ts';

export type ProtocolFormat = 'codex' | 'opencode';
export type OfflineScenario = 'success' | 'failure' | 'hang' | 'ignore-term' | 'completed-hang' | 'malformed' | 'oversized' | 'stderr-flood' | 'invalid-utf8' | 'env-check';
export interface ProcessObservation {
  kind: 'offline-owned-fixture'; format: ProtocolFormat;
  pid: number | null; exitCode: number | null; signal: NodeJS.Signals | null;
  reason: 'exited' | 'cancelled' | 'timeout' | 'protocol-error' | 'output-limit' | 'spawn-error' | 'cleanup-unconfirmed';
  closed: boolean; stdoutBytes: number; stderrBytes: number; runtimeVersion: string;
}
const scenarios: OfflineScenario[] = ['success', 'failure', 'hang', 'ignore-term', 'completed-hang', 'malformed', 'oversized', 'stderr-flood', 'invalid-utf8', 'env-check'];
/** Not an OS sandbox. Can launch ONLY the repository-owned, non-executing fixture.
 * No executable, argv, cwd or environment override is accepted. onLine is trusted
 * in-process decoding logic, not untrusted task content. Never use for real agents. */
export function captureOfflineProcess(format: ProtocolFormat, scenario: OfflineScenario, timeoutMs: number, signal: AbortSignal, onLine: (line: string) => void): Promise<ProcessObservation> {
  if (!['codex', 'opencode'].includes(format) || !scenarios.includes(scenario) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000 || !(signal instanceof AbortSignal) || typeof onLine !== 'function') throw new AdapterContractError('Invalid offline process request');
  const initial: ProcessObservation = { kind: 'offline-owned-fixture', format, pid: null, exitCode: null,
    signal: null, reason: 'exited', closed: false, stdoutBytes: 0, stderrBytes: 0, runtimeVersion: process.version };
  if (signal.aborted) return Promise.resolve({ ...initial, reason: 'cancelled', closed: true });
  const cwd = mkdtempSync(join(tmpdir(), 'forge-protocol-'));
  const script = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './offline-process-worker.ts' : './offline-process-worker.js', import.meta.url));
  return new Promise(resolve => {
    let settled = false;
    let pending = Buffer.alloc(0);
    let force: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const observation = { ...initial };
    // Absolute current Node executable, no shell, no execArgv/Node options inheritance.
    const launch = () => spawn(process.execPath, [script, format, scenario], {
      cwd, env: { NODE_NO_WARNINGS: '1', LANG: 'C.UTF-8' }, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let child: ReturnType<typeof launch>;
    try { child = launch(); } catch {
      observation.reason = 'spawn-error'; observation.closed = true;
      try { rmSync(cwd, { recursive: true }); } catch { observation.reason = 'cleanup-unconfirmed'; }
      resolve({ ...observation }); return;
    }
    observation.pid = child.pid ?? null;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true; observation.closed = closed;
      clearTimeout(deadline); clearTimeout(force); clearTimeout(watchdog);
      signal.removeEventListener('abort', abort);
      pending = Buffer.alloc(0);
      // A cleanup failure cannot turn failed/unknown execution into success.
      if (closed) { try { rmSync(cwd, { recursive: true }); } catch { observation.reason = 'cleanup-unconfirmed'; } }
      resolve({ ...observation });
    };
    const stop = (reason: ProcessObservation['reason']) => {
      if (settled) return;
      if (observation.reason !== 'exited') return;
      observation.reason = reason;
      child.kill('SIGTERM');
      force = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 100);
      watchdog = setTimeout(() => {
        if (settled) return;
        observation.reason = 'cleanup-unconfirmed';
        child.stdout.destroy(); child.stderr.destroy();
        finish(false); // Unknown cleanup is reported, never represented as reaped.
      }, 2000);
    };
    const abort = () => stop('cancelled');
    const line = (bytes: Buffer) => {
      if (bytes.length > 65536) { stop('output-limit'); return; }
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (onLine(text.endsWith('\r') ? text.slice(0, -1) : text) !== undefined) throw new Error();
      } catch { stop('protocol-error'); }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      observation.stdoutBytes += chunk.length;
      if (observation.reason !== 'exited') return;
      if (observation.stdoutBytes > 1048576) { stop('output-limit'); return; }
      pending = Buffer.concat([pending, chunk]);
      let end: number;
      while ((end = pending.indexOf(10)) >= 0 && observation.reason === 'exited') {
        line(pending.subarray(0, end)); pending = pending.subarray(end + 1);
      }
      if (pending.length > 65536) stop('output-limit');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      observation.stderrBytes += chunk.length;
      // stderr is counted, never decoded, logged or returned.
      if (observation.stderrBytes > 65536) stop('output-limit');
    });
    child.stdout.on('error', () => stop('protocol-error'));
    child.stderr.on('error', () => stop('protocol-error'));
    child.on('error', () => stop('spawn-error'));
    child.once('close', (code, exitSignal) => {
      observation.exitCode = code; observation.signal = exitSignal;
      if (observation.reason === 'exited' && pending.length) line(pending);
      finish(true);
    });
    const deadline = setTimeout(() => stop('timeout'), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
