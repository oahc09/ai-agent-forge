import { array, digest, ensure, id, integer, record, repo, sha, snapshot, unique } from '../../radar/src/boundary.ts';
import { validateExperimentPath } from './genes.ts';

export interface FixtureTask { id: string; digest: string; slice: string }
export interface ExperimentManifest {
  schemaVersion: 1; experimentId: string; repo: string; provenance: 'simulation';
  baselineCommit: string; candidateCommit: string; allowedPaths: string[];
  modelAndToolDigest: string; environmentDigest: string; evaluatorDigest: string;
  perTaskBudgetUnits: number; tasks: FixtureTask[]; criticalSlices: string[];
  bootstrap: { seed: number; iterations: number };
}
export interface PairedOutcome {
  commit: string; modelAndToolDigest: string; environmentDigest: string; budgetUnits: number;
  success: boolean; costUnits: number; latencyMs: number; safetyViolations: number;
}
export interface PairedRecord { taskId: string; taskDigest: string; slice: string; baseline: PairedOutcome; candidate: PairedOutcome }
export interface ArmSummary { successes: number; successRate: number; totalCostUnits: number; costPerSuccess: number | null; medianLatencyMs: number }
export interface FixtureBenchmarkReport {
  schemaVersion: 1; experimentId: string; provenance: 'simulation'; manifestDigest: string; rawRecordsDigest: string;
  n: number; baseline: ArmSummary; candidate: ArmSummary; effectPercentagePoints: number;
  bootstrap95: { lower: number; upper: number; seed: number; iterations: number; method: 'paired-percentile' };
  slices: Array<{ slice: string; n: number; effectPercentagePoints: number }>;
  rawRecords: PairedRecord[]; failureReasons: string[];
  fixtureRecommendation: 'CANDIDATE_FOR_HUMAN_REVIEW' | 'REJECT';
  claim: { outcome: 'NOT_PROVEN'; g8: 'NOT_VERIFIED'; reason: string };
}
function validateManifest(value: unknown): asserts value is ExperimentManifest {
  record(value, ['schemaVersion', 'experimentId', 'repo', 'provenance', 'baselineCommit', 'candidateCommit', 'allowedPaths', 'modelAndToolDigest', 'environmentDigest', 'evaluatorDigest', 'perTaskBudgetUnits', 'tasks', 'criticalSlices', 'bootstrap']);
  ensure(value.schemaVersion === 1 && value.provenance === 'simulation', 'Offline preview only accepts simulation, never provider-real');
  id(value.experimentId); repo(value.repo); sha(value.baselineCommit, 40); sha(value.candidateCommit, 40);
  ensure(value.baselineCommit !== value.candidateCommit, 'Baseline and candidate must differ');
  array(value.allowedPaths, 1, 100); value.allowedPaths.forEach(validateExperimentPath); unique(value.allowedPaths as string[]);
  sha(value.modelAndToolDigest, 64); sha(value.environmentDigest, 64); sha(value.evaluatorDigest, 64);
  integer(value.perTaskBudgetUnits, 1, 1_000_000); array(value.tasks, 1, 2000);
  for (const task of value.tasks) { record(task, ['id', 'digest', 'slice']); id(task.id); sha(task.digest, 64); id(task.slice); }
  const tasks = value.tasks as unknown as FixtureTask[];
  unique(tasks.map(task => task.id)); unique(tasks.map(task => task.digest));
  array(value.criticalSlices, 1, 100); value.criticalSlices.forEach(item => id(item)); unique(value.criticalSlices as string[]);
  ensure(value.criticalSlices.every(slice => tasks.some(task => task.slice === slice)), 'Critical slice absent from preregistered fixture');
  record(value.bootstrap, ['seed', 'iterations']); integer(value.bootstrap.seed, 1, 0xffffffff); integer(value.bootstrap.iterations, 1000, 10_000);
  ensure(value.tasks.length * value.bootstrap.iterations <= 5_000_000, 'Bootstrap work limit exceeded');
}
function validateOutcome(value: unknown, manifest: ExperimentManifest, commit: string): asserts value is PairedOutcome {
  record(value, ['commit', 'modelAndToolDigest', 'environmentDigest', 'budgetUnits', 'success', 'costUnits', 'latencyMs', 'safetyViolations']);
  ensure(value.commit === commit && value.modelAndToolDigest === manifest.modelAndToolDigest && value.environmentDigest === manifest.environmentDigest && value.budgetUnits === manifest.perTaskBudgetUnits, 'Paired model, environment, commit or budget controls differ');
  ensure(typeof value.success === 'boolean', 'Success must be boolean'); integer(value.costUnits, 0, manifest.perTaskBudgetUnits);
  integer(value.latencyMs, 0, 86_400_000); integer(value.safetyViolations, 0, 1_000_000);
}
function median(values: number[]): number {
  values.sort((a, b) => a - b); const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[middle - 1]! + values[middle]!) / 2 : values[middle]!;
}
function armSummary(outcomes: PairedOutcome[]): ArmSummary {
  const successes = outcomes.filter(item => item.success).length;
  const totalCostUnits = outcomes.reduce((sum, item) => sum + item.costUnits, 0);
  return { successes, successRate: successes / outcomes.length, totalCostUnits, costPerSuccess: successes ? totalCostUnits / successes : null, medianLatencyMs: median(outcomes.map(item => item.latencyMs)) };
}
/** Seeded simulation helper, not an independent statistical evaluator. Sampling
 * paired differences together preserves baseline/candidate task correlation. */
function pairedBootstrap(differences: number[], seed: number, iterations: number): { lower: number; upper: number } {
  let state = seed >>> 0;
  const random = (): number => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000; };
  const means: number[] = [];
  for (let run = 0; run < iterations; run++) {
    let sum = 0;
    for (let draw = 0; draw < differences.length; draw++) sum += differences[Math.floor(random() * differences.length)]!;
    means.push(sum * 100 / differences.length);
  }
  means.sort((a, b) => a - b);
  return { lower: means[Math.floor(0.025 * (iterations - 1))]!, upper: means[Math.ceil(0.975 * (iterations - 1))]! };
}
/** Stores paired SIMULATION observations supplied by a trusted host. It does not
 * run experiments, access hidden samples, certify independence, or issue a real
 * EvolutionClaim. Manifest freezing is local and is not a real preregistration. */
export class OfflineExperiment {
  private readonly manifest: ExperimentManifest;
  private readonly observations = new Map<string, PairedRecord>();
  private readonly quarantineReasons: string[] = [];
  private inspectedPaths: readonly string[] | null = null;
  constructor(value: unknown) { validateManifest(value); this.manifest = snapshot(value); }
  inspectChanges(paths: unknown): { allowed: boolean; status: 'CANDIDATE' | 'QUARANTINED' } {
    ensure(this.quarantineReasons.length === 0, 'Experiment quarantined');
    try {
      array(paths, 1, 100); paths.forEach(validateExperimentPath); unique(paths as string[]);
      ensure(paths.every(path => this.manifest.allowedPaths.includes(path as string)), 'Path outside frozen target');
      ensure(this.observations.size === 0 && this.inspectedPaths === null, 'Change manifest is already frozen');
      this.inspectedPaths = snapshot(paths as string[]);
      return { allowed: true, status: 'CANDIDATE' };
    } catch {
      this.quarantineReasons.push('Candidate attempted a protected, malformed or non-allowlisted path');
      return { allowed: false, status: 'QUARANTINED' };
    }
  }
  record(values: unknown): void {
    ensure(this.quarantineReasons.length === 0, 'Experiment quarantined'); array(values, 1, 2000);
    const pending = new Map<string, PairedRecord>();
    for (const value of values) {
      record(value, ['taskId', 'taskDigest', 'slice', 'baseline', 'candidate']); id(value.taskId); sha(value.taskDigest, 64); id(value.slice);
      const task = this.manifest.tasks.find(task => task.id === value.taskId);
      ensure(task && task.digest === value.taskDigest && task.slice === value.slice, 'Task outside frozen fixture');
      ensure(!this.observations.has(value.taskId) && !pending.has(value.taskId), 'Duplicate paired task');
      validateOutcome(value.baseline, this.manifest, this.manifest.baselineCommit); validateOutcome(value.candidate, this.manifest, this.manifest.candidateCommit);
      pending.set(value.taskId, snapshot(value as unknown as PairedRecord));
    }
    for (const [key, value] of pending) this.observations.set(key, value);
  }
  definition(): ExperimentManifest { return structuredClone(this.manifest); }
  report(): FixtureBenchmarkReport {
    ensure(this.observations.size === this.manifest.tasks.length, 'All frozen paired tasks, including failures, are required');
    const rawRecords = this.manifest.tasks.map(task => this.observations.get(task.id)!);
    const baseline = armSummary(rawRecords.map(row => row.baseline)); const candidate = armSummary(rawRecords.map(row => row.candidate));
    const differences = rawRecords.map(row => Number(row.candidate.success) - Number(row.baseline.success));
    const effectPercentagePoints = differences.reduce((sum, value) => sum + value, 0) * 100 / rawRecords.length;
    const bootstrap95 = { ...pairedBootstrap(differences, this.manifest.bootstrap.seed, this.manifest.bootstrap.iterations), ...this.manifest.bootstrap, method: 'paired-percentile' as const };
    const slices = [...new Set(this.manifest.tasks.map(task => task.slice))].sort().map(slice => {
      const rows = rawRecords.filter(row => row.slice === slice);
      return { slice, n: rows.length, effectPercentagePoints: rows.reduce((sum, row) => sum + Number(row.candidate.success) - Number(row.baseline.success), 0) * 100 / rows.length };
    });
    const failureReasons = [...this.quarantineReasons];
    if (this.inspectedPaths === null) failureReasons.push('Candidate change paths were not inspected before observation');
    if (rawRecords.length < 100) failureReasons.push('Fewer than 100 paired fixture tasks');
    if (effectPercentagePoints < 5) failureReasons.push('Absolute success gain below 5 percentage points');
    if (bootstrap95.lower <= 0) failureReasons.push('Paired bootstrap lower bound is not positive');
    if (baseline.costPerSuccess === null || candidate.costPerSuccess === null || candidate.costPerSuccess > baseline.costPerSuccess * 1.10) failureReasons.push('Cost per success is undefined or increases by more than 10%');
    if (slices.some(slice => this.manifest.criticalSlices.includes(slice.slice) && slice.effectPercentagePoints < -2)) failureReasons.push('Critical slice regresses by more than 2 percentage points');
    if (rawRecords.some(row => row.baseline.safetyViolations > 0 || row.candidate.safetyViolations > 0)) failureReasons.push('Safety violations present');
    return structuredClone({
      schemaVersion: 1, experimentId: this.manifest.experimentId, provenance: 'simulation', manifestDigest: digest(this.manifest), rawRecordsDigest: digest(rawRecords),
      n: rawRecords.length, baseline, candidate, effectPercentagePoints, bootstrap95, slices, rawRecords, failureReasons,
      fixtureRecommendation: failureReasons.length ? 'REJECT' : 'CANDIDATE_FOR_HUMAN_REVIEW',
      claim: { outcome: 'NOT_PROVEN', g8: 'NOT_VERIFIED', reason: 'Simulation only. No real preregistration, independently executed provider-real tasks, protected hidden confirmation set, multiple-testing control or authenticated independent evaluator.' },
    } satisfies FixtureBenchmarkReport);
  }
}
