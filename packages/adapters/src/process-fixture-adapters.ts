import { AdapterContractError, validateAgentRunInput } from '../../execution/src/index.ts';
import type { AgentAdapter, AgentRunInput, AgentRunEvent } from '../../execution/src/index.ts';
import { CodexJsonlDecoder } from './codex-jsonl.ts';
import { OpenCodeJsonlDecoder } from './opencode-jsonl.ts';
import { captureOfflineProcess } from './offline-process.ts';
import type { OfflineScenario, ProcessObservation, ProtocolFormat } from './offline-process.ts';
import type { ReportedUsage } from './jsonl-protocol.ts';

type Run = { control: AbortController; detach: () => void; quarantined?: boolean; done?: Promise<AgentRunEvent[]> };
export interface OfflineRunObservation { process: ProcessObservation; usage: ReportedUsage[]; realProvider: false; isolationVerified: false }
/** SDK lifecycle integration exercised with owned subprocess fixtures only.
 * Not a real Codex/OpenCode launcher and never selected by the CLI/daemon. */
abstract class ProcessFixtureAdapter implements AgentAdapter {
  abstract readonly id: string;
  private readonly used = new Set<string>();
  private readonly runs = new Map<string, Run>();
  private readonly observations = new Map<string, OfflineRunObservation>();
  private readonly format: ProtocolFormat;
  private readonly scenario: OfflineScenario;
  protected constructor(format: ProtocolFormat, scenario: OfflineScenario) { this.format = format; this.scenario = scenario; }
  async capabilities() { return { streaming: false, resume: false, cancellation: true, toolCalls: false, contextHandoff: 'none' as const }; }
  observation(runId: string): OfflineRunObservation | null { return structuredClone(this.observations.get(runId) ?? null); }
  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.control.abort();
    try { if (run.done) await run.done; } finally { run.detach(); if (!run.quarantined) this.runs.delete(runId); }
  }
  start(input: AgentRunInput, signal: AbortSignal): AsyncIterable<AgentRunEvent> {
    validateAgentRunInput(input);
    if (!(signal instanceof AbortSignal) || input.budget.timeoutMs > 5000 || input.budget.maxTokens !== 0 || input.budget.maxCalls !== 0 || input.budget.maxCostMicros !== 0 || input.permissions.commands.length || input.permissions.networkDomains.length || input.permissions.writePaths.length) throw new AdapterContractError('Only zero-provider-budget, non-executing fixtures are supported');
    if (this.used.has(input.runId) || this.used.size >= 10000 || this.runs.size >= 32) throw new AdapterContractError('Run ID reused or offline capacity exhausted');
    this.used.add(input.runId);
    const reservedRunId = input.runId;
    const run: Run = { control: new AbortController(), detach: () => {} }; this.runs.set(input.runId, run);
    const onCallerAbort = () => {
      run.control.abort();
      if (!run.done) this.runs.delete(reservedRunId);
      run.detach();
    };
    run.detach = () => signal.removeEventListener('abort', onCallerAbort);
    signal.addEventListener('abort', onCallerAbort, { once: true });
    if (signal.aborted) onCallerAbort();
    const snapshot = structuredClone(input);
    let closed = false, offset = 0;
    const done = (): IteratorResult<AgentRunEvent> => ({ done: true, value: undefined });
    const release = () => {
      closed = true; run.control.abort(); run.detach();
      // An active child owns its slot until execute finally observes cleanup.
      if (!run.done) this.runs.delete(snapshot.runId);
    };
    const execute = () => this.execute(snapshot, run);
    const iterator: AsyncIterableIterator<AgentRunEvent> = {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (closed) return done();
        // Promise creation is synchronous; concurrent next() cannot launch twice.
        run.done ??= execute();
        try {
          const events = await run.done;
          if (closed) return done();
          const value = events[offset++];
          if (!value) { release(); return done(); }
          return { done: false, value };
        } catch { release(); throw new AdapterContractError('Offline process adapter failed'); }
      },
      async return() { release(); if (run.done) await run.done; return done(); },
      async throw() { release(); if (run.done) await run.done; throw new AdapterContractError('Offline iterator closed'); },
    };
    return iterator;
  }
  private async execute(input: AgentRunInput, run: Run): Promise<AgentRunEvent[]> {
    try {
      validateAgentRunInput(input);
      const decoder = this.format === 'codex' ? new CodexJsonlDecoder(input) : new OpenCodeJsonlDecoder(input);
      const events: AgentRunEvent[] = [];
      const observation = await captureOfflineProcess(this.format, this.scenario, input.budget.timeoutMs, run.control.signal, line => { events.push(...decoder.acceptLine(line)); });
      if (!observation.closed) run.quarantined = true;
      const outcome = observation.closed && observation.reason === 'cancelled' ? 'cancelled' : observation.closed && observation.reason === 'timeout' ? 'timeout' : 'exited';
      const exitCode = observation.closed && observation.reason === 'exited' ? observation.exitCode : null;
      events.push(...decoder.finish(exitCode, outcome));
      this.observations.set(input.runId, { process: observation, usage: decoder.reportedUsage(), realProvider: false, isolationVerified: false });
      if (this.observations.size > 128) this.observations.delete(this.observations.keys().next().value!);
      return events;
    } finally { run.detach(); if (!run.quarantined) this.runs.delete(input.runId); }
  }
}
export class CodexFixtureProcessAdapter extends ProcessFixtureAdapter {
  readonly id = 'codex-protocol-process-fixture';
  constructor(scenario: OfflineScenario = 'success') { super('codex', scenario); }
}
export class OpenCodeFixtureProcessAdapter extends ProcessFixtureAdapter {
  readonly id = 'opencode-protocol-process-fixture';
  constructor(scenario: OfflineScenario = 'success') { super('opencode', scenario); }
}
