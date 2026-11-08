/** M0 bootstrap configuration. Active grants are deliberately unsupported until G0 review. */
export interface BootstrapPolicy {
  schemaVersion: 1;
  observeOnly: true;
  repository: string;
  provider: 'fake';
  budgetUsd: 0;
  networkDomains: [];
  remoteWrite: false;
  merge: false;
  deploy: false;
  maxAttempts: number;
  maxEventHops: number;
  maxConcurrentWorkers: number;
}
export function defaultPolicy(repository = 'https://github.com/oahc09/ai-agent-forge'): BootstrapPolicy {
  return {schemaVersion:1, observeOnly:true, repository, provider:'fake', budgetUsd:0,
    networkDomains:[], remoteWrite:false, merge:false, deploy:false,
    maxAttempts:3, maxEventHops:8, maxConcurrentWorkers:1};
}
export function parsePolicy(value: unknown): BootstrapPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Policy must be an object');
  const data = value as Record<string, unknown>;
  const defaults = defaultPolicy();
  const keys = Object.keys(defaults);
  if (Object.keys(data).length !== keys.length || Object.keys(data).some(key => !keys.includes(key))) throw new Error('Unknown or missing policy field');
  for (const key of ['schemaVersion','observeOnly','provider','budgetUsd','remoteWrite','merge','deploy'] as const) {
    if (data[key] !== defaults[key]) throw new Error(`Unsafe bootstrap policy: ${key}`);
  }
  if (typeof data.repository !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(data.repository)) throw new Error('Expected a canonical GitHub repository URL');
  if (data.repository.trim() !== data.repository) throw new Error('Repository URL must not contain surrounding whitespace');
  if (['.', '..'].includes(data.repository.split('/').at(-1) ?? '')) throw new Error('Repository path must not be a dot segment');
  if (!Array.isArray(data.networkDomains) || data.networkDomains.length !== 0) throw new Error('Network is disabled in M0');
  for (const [key, max] of [['maxAttempts',3],['maxEventHops',8],['maxConcurrentWorkers',3]] as const) {
    const n = data[key];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > max) throw new Error(`Invalid limit: ${key}`);
  }
  return structuredClone(data) as unknown as BootstrapPolicy;
}
export function authorizeBootstrapAction(policy: unknown, action: string): {allowed: boolean; reason: string} {
  parsePolicy(policy);
  return action === 'observe' || action === 'offline-fixture'
    ? {allowed:true, reason:'Offline bootstrap operation'}
    : {allowed:false, reason:'M0 observe-only: active operations require later gate implementation and explicit authorization'};
}
