import { array, digest, ensure, id, integer, record, repo, sha, snapshot, text, unique } from './boundary.ts';
export { ResearchBoundaryError } from './boundary.ts';

export interface RadarSource { id: string; repo: string; kind: 'commit' | 'release' | 'pull-request' }
export interface RadarObservation {
  repo: string; commit: string; mechanismDigest: string; referenceUrl: string;
  contentDigest: string; bodyRef: string;
}
export interface RadarCandidate {
  id: string; repo: string; commit: string; mechanismDigest: string;
  sourceIds: string[]; references: Array<{ url: string; contentDigest: string; bodyRef: string }>;
  status: 'DISCOVERED' | 'REJECTED'; rejectionReason: string | null;
  trust: 'untrusted-source-metadata';
}
export interface RadarRequest { readonly source: Readonly<RadarSource>; readonly cursor: string | null; readonly attempt: number }
export interface RadarOptions { maxAttempts: number; baseDelayMs: number; maxCandidates: number }
interface SourceState { cursor: string | null; attempts: number; retryAt: number; inFlight: boolean; exhausted: boolean; lastTime: number }
function validateSource(value: unknown): asserts value is RadarSource {
  record(value, ['id', 'repo', 'kind']); id(value.id); repo(value.repo);
  ensure(['commit', 'release', 'pull-request'].includes(value.kind as string), 'Invalid source kind');
}
function validateObservation(value: unknown, source: RadarSource): asserts value is RadarObservation {
  record(value, ['repo', 'commit', 'mechanismDigest', 'referenceUrl', 'contentDigest', 'bodyRef']);
  repo(value.repo); ensure(value.repo === source.repo, 'Source repository mismatch');
  sha(value.commit, 40); sha(value.mechanismDigest, 64); sha(value.contentDigest, 64); id(value.bodyRef);
  text(value.referenceUrl, 1024);
  const suffix = value.referenceUrl.slice(source.repo.length);
  const expected = source.kind === 'commit' ? `/commit/${value.commit}` : source.kind === 'release' ? /^\/releases\/tag\/[a-zA-Z0-9._-]+$/ : /^\/pull\/[1-9][0-9]*$/;
  ensure(value.referenceUrl.startsWith(source.repo) && (typeof expected === 'string' ? suffix === expected : expected.test(suffix)), 'Reference outside fixed source');
}
/** Offline ingestion ledger, not a network fetcher or sandbox. The trusted host
 * supplies fixed sources and fetched metadata; source bodies are never executed
 * or interpreted as authorization. Request handles are process-local capabilities. */
export class OfflineRadar {
  private readonly sources = new Map<string, RadarSource>();
  private readonly states = new Map<string, SourceState>();
  private readonly requests = new Map<RadarRequest, { sourceId: string; startedAt: number }>();
  private readonly items = new Map<string, RadarCandidate>();
  private readonly options: RadarOptions;
  constructor(sources: unknown, options: RadarOptions = { maxAttempts: 3, baseDelayMs: 1000, maxCandidates: 1000 }) {
    array(sources, 1, 1000); record(options, ['maxAttempts', 'baseDelayMs', 'maxCandidates']);
    integer(options.maxAttempts, 1, 10); integer(options.baseDelayMs, 1, 3_600_000); integer(options.maxCandidates, 1, 10_000);
    const checkedSources = sources.map(source => { validateSource(source); return source; });
    unique(checkedSources.map(source => source.id));
    unique(checkedSources.map(source => `${source.repo.toLowerCase()}:${source.kind}`));
    this.options = snapshot(options);
    for (const source of checkedSources) {
      this.sources.set(source.id, snapshot(source));
      this.states.set(source.id, { cursor: null, attempts: 0, retryAt: 0, inFlight: false, exhausted: false, lastTime: 0 });
    }
  }
  private state(sourceId: string, now: number): SourceState {
    id(sourceId); integer(now, 0, Number.MAX_SAFE_INTEGER - 4_000_000_000);
    const state = this.states.get(sourceId); ensure(state, 'Source not allowlisted');
    ensure(now >= state.lastTime, 'Non-monotonic host clock'); return state;
  }
  begin(sourceId: string, now: number): RadarRequest {
    const state = this.state(sourceId, now);
    ensure(!state.exhausted, 'Source retries exhausted'); ensure(!state.inFlight, 'Source request already in flight');
    ensure(now >= state.retryAt, 'Source retry backoff active');
    const request: RadarRequest = snapshot({ source: this.sources.get(sourceId)!, cursor: state.cursor, attempt: state.attempts + 1 });
    state.inFlight = true; state.lastTime = now; this.requests.set(request, { sourceId, startedAt: now }); return request;
  }
  private pending(request: RadarRequest, now: number): SourceState {
    const issued = this.requests.get(request); ensure(issued, 'Unknown, forged or consumed request');
    ensure(now >= issued.startedAt, 'Completion predates request'); return this.state(issued.sourceId, now);
  }
  complete(request: RadarRequest, page: unknown, now: number): RadarCandidate[] {
    const state = this.pending(request, now);
    record(page, ['observations', 'nextCursor']); array(page.observations, 0, 100);
    if (page.nextCursor !== null) text(page.nextCursor, 512);
    const staged = new Map<string, RadarCandidate>();
    for (const observation of page.observations) {
      validateObservation(observation, request.source);
      const key = digest([observation.repo.toLowerCase(), observation.commit, observation.mechanismDigest]);
      const item = structuredClone(staged.get(key) ?? this.items.get(key) ?? {
        id: key, repo: observation.repo, commit: observation.commit, mechanismDigest: observation.mechanismDigest,
        sourceIds: [], references: [], status: 'DISCOVERED', rejectionReason: null, trust: 'untrusted-source-metadata',
      } satisfies RadarCandidate);
      if (!item.sourceIds.includes(request.source.id)) item.sourceIds.push(request.source.id);
      const reference = { url: observation.referenceUrl, contentDigest: observation.contentDigest, bodyRef: observation.bodyRef };
      const prior = item.references.find(existing => existing.url === reference.url);
      ensure(!prior || (prior.contentDigest === reference.contentDigest && prior.bodyRef === reference.bodyRef), 'Conflicting immutable source reference');
      if (!prior) item.references.push(reference);
      ensure(item.references.length <= 100 && item.sourceIds.length <= 100, 'Candidate reference limit exceeded');
      staged.set(key, item);
    }
    const additional = [...staged.keys()].filter(key => !this.items.has(key)).length;
    ensure(this.items.size + additional <= this.options.maxCandidates, 'Candidate archive limit exceeded');
    // Commit only after the entire page validates; rejected pages cannot skip a cursor.
    for (const [key, item] of staged) this.items.set(key, snapshot(item));
    state.cursor = page.nextCursor as string | null; state.attempts = 0; state.retryAt = now;
    state.inFlight = false; state.lastTime = now; this.requests.delete(request);
    return structuredClone([...staged.values()]);
  }
  fail(request: RadarRequest, reason: 'fetch-failed' | 'invalid-page' | 'timeout', now: number): void {
    const state = this.pending(request, now);
    ensure(['fetch-failed', 'invalid-page', 'timeout'].includes(reason), 'Invalid failure reason');
    state.attempts++; state.exhausted = state.attempts >= this.options.maxAttempts;
    state.retryAt = now + this.options.baseDelayMs * 2 ** (state.attempts - 1);
    state.lastTime = now; state.inFlight = false; this.requests.delete(request);
  }
  reject(candidateId: string, reason: string): void {
    text(reason, 1000); const item = this.items.get(candidateId); ensure(item, 'Unknown candidate');
    ensure(item.status === 'DISCOVERED', 'Candidate already rejected');
    this.items.set(candidateId, snapshot({ ...item, status: 'REJECTED', rejectionReason: reason }));
  }
  candidates(): RadarCandidate[] { return structuredClone([...this.items.values()]); }
  status(sourceId: string): Readonly<SourceState> {
    const state = this.states.get(sourceId); ensure(state, 'Source not allowlisted'); return structuredClone(state);
  }
}
