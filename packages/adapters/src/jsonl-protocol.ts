import { AdapterContractError, AgentEventStreamValidator, validateAgentRunInput, validateAgentRunEvent } from '../../execution/src/index.ts';
import type { AgentRunEvent, AgentRunInput } from '../../execution/src/index.ts';

export interface ReportedUsage {
  source: 'codex-turn' | 'opencode-step';
  inputTokens: number; outputTokens: number; cachedInputTokens: number;
  cacheWriteTokens: number | null; reasoningTokens: number | null;
  /** Provider-reported estimate only, not verified billing or a budget grant. */
  reportedCostUsd: number | null;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdapterContractError('Expected protocol object');
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new AdapterContractError('Invalid protocol identity');
  return value;
}
export function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new AdapterContractError('Invalid reported usage');
  return value as number;
}
export function optionalCount(value: unknown): number | null { return value === undefined ? null : count(value); }

/** Pure incremental protocol decoder. No process, filesystem, network, credentials,
 * authorization or model calls. The caller must obtain actual exit/cancellation
 * evidence from a trusted isolated runner; JSON cannot establish that evidence. */
export abstract class JsonlProtocolDecoder {
  private readonly input: AgentRunInput;
  private readonly validator: AgentEventStreamValidator;
  private sequence = 0;
  private closed = false;
  private invalid = false;
  private started = false;
  private lines = 0;
  private bufferedText = '';
  protected providerFailed = false;
  protected readonly usage: ReportedUsage[] = [];
  protected constructor(input: AgentRunInput) {
    validateAgentRunInput(input);
    this.input = structuredClone(input);
    this.validator = new AgentEventStreamValidator(input.taskId, input.runId);
  }
  protected abstract consume(event: Record<string, unknown>): string[];
  protected abstract complete(): boolean;
  /** One complete JSON line, not an arbitrary byte chunk. Bounded framing is the runner's job. */
  acceptLine(line: string): AgentRunEvent[] {
    if (this.closed || this.invalid) throw new AdapterContractError('Protocol stream is closed or invalid');
    try {
      validateAgentRunInput(this.input);
      if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > 65536 || ++this.lines > 10000 || !line.trim()) throw new Error();
      const raw = object(JSON.parse(line) as unknown);
      const output = this.consume(raw);
      for (const text of output) {
        if (typeof text !== 'string' || this.bufferedText.length + text.length > 4096) throw new Error();
        this.bufferedText += text;
      }
      // Do not emit partial text: credentials may straddle JSONL records. Preserve
      // whitespace deltas and validate the entire bounded response at process exit.
      const events: AgentRunEvent[] = [];
      if (!this.started) { events.push(this.emit({ type: 'status', status: 'running' })); this.started = true; }
      return events;
    } catch {
      this.invalid = true;
      // Never echo untrusted JSON, provider errors, tool arguments or potential credentials.
      throw new AdapterContractError('Invalid or unsupported provider protocol');
    }
  }
  /** Call only after stdout has drained AND the trusted runner has observed process exit.
   * A provider completion record alone never emits succeeded. null means unknown exit. */
  finish(exitCode: number | null, outcome: 'exited' | 'cancelled' | 'timeout' = 'exited'): AgentRunEvent[] {
    if (this.closed) throw new AdapterContractError('Protocol stream already finished');
    if (exitCode !== null && (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255)) throw new AdapterContractError('Invalid process exit');
    if (!['exited', 'cancelled', 'timeout'].includes(outcome)) throw new AdapterContractError('Invalid process outcome');
    this.closed = true;
    const events: AgentRunEvent[] = [];
    if (!this.started) { events.push(this.emit({ type: 'status', status: 'running' })); this.started = true; }
    if (outcome === 'cancelled') events.push(this.emit({ type: 'status', status: 'cancelled' }));
    else if (outcome === 'timeout') events.push(this.emit({ type: 'failure', status: 'failed', code: 'TIMEOUT', retryable: true }));
    else if (exitCode === 0 && !this.invalid && !this.providerFailed && this.complete()) {
      try {
        if (this.bufferedText.trim()) validateAgentRunEvent({ schemaVersion: 1, taskId: this.input.taskId, runId: this.input.runId, sequence: 1, occurredAt: new Date().toISOString(), type: 'output', text: this.bufferedText });
      } catch { this.invalid = true; }
      if (this.invalid) events.push(this.emit({ type: 'failure', status: 'failed', code: 'ADAPTER_FAILURE', retryable: false }));
      else {
        if (this.bufferedText.trim()) events.push(this.emit({ type: 'output', text: this.bufferedText }));
        events.push(this.emit({ type: 'status', status: 'succeeded' }));
      }
    }
    else events.push(this.emit({ type: 'failure', status: 'failed', code: 'ADAPTER_FAILURE', retryable: false }));
    this.bufferedText = '';
    this.validator.finish();
    return events;
  }
  reportedUsage(): ReportedUsage[] { return structuredClone(this.usage); }
  private emit(body: { type: 'status'; status: 'running' | 'succeeded' | 'cancelled' } | { type: 'output'; text: string } | { type: 'failure'; status: 'failed'; code: 'TIMEOUT' | 'ADAPTER_FAILURE'; retryable: boolean }): AgentRunEvent {
    const event: AgentRunEvent = { schemaVersion: 1, taskId: this.input.taskId, runId: this.input.runId,
      sequence: this.sequence + 1, occurredAt: new Date().toISOString(), ...body };
    this.validator.accept(event); this.sequence++; return event;
  }
}
