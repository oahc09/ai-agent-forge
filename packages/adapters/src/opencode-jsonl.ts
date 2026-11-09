import type { AgentRunInput } from '../../execution/src/index.ts';
import { AdapterContractError } from '../../execution/src/index.ts';
import { JsonlProtocolDecoder, object, identifier, count } from './jsonl-protocol.ts';

/** OpenCode run --format json. A step_finish is NOT task completion: the trusted
 * runner must drain stdout and report exit after background jobs have settled. */
export class OpenCodeJsonlDecoder extends JsonlProtocolDecoder {
  private session: string | null = null;
  private steps = new Map<string, 'running' | 'done'>();
  private lastReason: string | null = null;
  constructor(input: AgentRunInput) { super(input); }
  protected consume(event: Record<string, unknown>): string[] {
    if (this.providerFailed) throw new AdapterContractError('Record after provider error');
    if (event.type === 'error') { this.providerFailed = true; return []; }
    const session = identifier(event.sessionID);
    if (this.session !== null && this.session !== session) throw new AdapterContractError('Mixed OpenCode sessions');
    this.session = session;
    if (event.type === 'background_wait') return [];
    if (event.type === 'retry') {
      // These may occur after a step finishes. They cannot establish success.
      this.lastReason = null; return [];
    }
    const part = object(event.part);
    if (part.sessionID !== session) throw new AdapterContractError('Part session mismatch');
    const message = identifier(part.messageID);
    identifier(part.id ?? part.partID);
    if (event.type === 'step_start') {
      if (part.type !== 'step-start' || this.steps.has(message)) throw new AdapterContractError('Duplicate/invalid step');
      this.steps.set(message, 'running'); this.lastReason = null; return [];
    }
    // Upstream reconcile may emit missed text/tool parts after step_finish.
    // They are accepted only for known messages and still buffered until exit.
    if (!this.steps.has(message)) throw new AdapterContractError('Missing step');
    if (event.type === 'text') {
      if (part.type !== 'text' || typeof part.text !== 'string') throw new AdapterContractError('Invalid OpenCode text');
      return [part.text];
    }
    if (event.type === 'reasoning' || event.type === 'tool_use') return [];
    if (event.type === 'step_finish') {
      if (this.steps.get(message) !== 'running') throw new AdapterContractError('Duplicate step finish');
      if (part.type !== 'step-finish' || !['stop', 'length', 'tool-calls', 'content-filter', 'error', 'unknown'].includes(String(part.reason))) throw new AdapterContractError('Invalid step outcome');
      const tokens = object(part.tokens), cache = object(tokens.cache);
      const cost = part.cost;
      if (cost !== undefined && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) throw new AdapterContractError('Invalid reported cost');
      this.usage.push({ source: 'opencode-step', inputTokens: count(tokens.input), outputTokens: count(tokens.output),
        cachedInputTokens: count(cache.read), cacheWriteTokens: count(cache.write), reasoningTokens: count(tokens.reasoning),
        reportedCostUsd: typeof cost === 'number' ? cost : null });
      this.steps.set(message, 'done'); this.lastReason = String(part.reason);
      if (!['stop', 'tool-calls'].includes(this.lastReason)) this.providerFailed = true;
      return [];
    }
    throw new AdapterContractError('Unsupported OpenCode record');
  }
  protected complete(): boolean {
    return this.steps.size > 0 && [...this.steps.values()].every(value => value === 'done') && this.lastReason === 'stop';
  }
}
