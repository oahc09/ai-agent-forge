import type { AgentRunInput } from '../../execution/src/index.ts';
import { AdapterContractError } from '../../execution/src/index.ts';
import { JsonlProtocolDecoder, object, identifier, count, optionalCount } from './jsonl-protocol.ts';

/** Codex exec JSONL, single new thread/turn. No CLI launch or native resume. */
export class CodexJsonlDecoder extends JsonlProtocolDecoder {
  private phase: 'new' | 'thread' | 'turn' | 'done' = 'new';
  private completedItems = new Set<string>();
  private pendingItems = new Set<string>();
  constructor(input: AgentRunInput) { super(input); }
  protected consume(event: Record<string, unknown>): string[] {
    if (this.phase === 'done') throw new AdapterContractError('Record after turn outcome');
    if (event.type === 'error' || event.type === 'turn.failed') {
      this.providerFailed = true; this.phase = 'done'; return [];
    }
    if (event.type === 'thread.started' && this.phase === 'new') {
      identifier(event.thread_id); this.phase = 'thread'; return [];
    }
    if (event.type === 'turn.started' && this.phase === 'thread') { this.phase = 'turn'; return []; }
    if (this.phase !== 'turn') throw new AdapterContractError('Unexpected Codex lifecycle');
    if (event.type === 'turn.completed') {
      if (this.pendingItems.size > 0) throw new AdapterContractError('Unfinished Codex items');
      const usage = object(event.usage);
      this.usage.push({ source: 'codex-turn', inputTokens: count(usage.input_tokens),
        outputTokens: count(usage.output_tokens), cachedInputTokens: count(usage.cached_input_tokens),
        cacheWriteTokens: optionalCount(usage.cache_write_input_tokens), reasoningTokens: optionalCount(usage.reasoning_output_tokens),
        reportedCostUsd: null });
      this.phase = 'done'; return [];
    }
    if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
      const item = object(event.item); const id = identifier(item.id);
      if (!['agent_message', 'reasoning', 'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list', 'error'].includes(String(item.type))) throw new AdapterContractError('Unsupported Codex item');
      if (this.completedItems.has(id)) throw new AdapterContractError('Duplicate or reopened item');
      if (event.type !== 'item.completed') {
        if (event.type === 'item.started' && this.pendingItems.has(id)) throw new AdapterContractError('Duplicate item start');
        this.pendingItems.add(id); return [];
      }
      this.pendingItems.delete(id);
      this.completedItems.add(id);
      if (item.type === 'agent_message') {
        if (typeof item.text !== 'string') throw new AdapterContractError('Missing agent message');
        return [item.text];
      }
      // Tool records are observed, never executed or interpreted as policy authority.
      return [];
    }
    throw new AdapterContractError('Unsupported Codex record');
  }
  protected complete(): boolean { return this.phase === 'done' && this.usage.length === 1; }
}
