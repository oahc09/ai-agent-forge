import { ensure, id, integer, record, snapshot } from '../../radar/src/boundary.ts';
export interface CandidateReservation { readonly candidateId: string; readonly reservedUnits: number }
export interface SearchEntry {
  candidateId: string; reservedUnits: number;
  outcome: 'pending' | 'failed' | 'no-improvement' | 'improved-fixture' | 'cancelled'; evidenceRef: string | null;
}
/** Bounded offline candidate archive. Reservation consumes the whole budget even
 * after failure/cancellation; no refunds, provider calls, hidden-set access or
 * automatic promotion. The host, not source text, owns this controller. */
export class OfflineSearch {
  private readonly maxCandidates: number;
  private readonly budgetUnits: number;
  private spentUnits = 0;
  private readonly entries = new Map<string, SearchEntry>();
  private readonly reservations = new Map<CandidateReservation, string>();
  constructor(options: { maxCandidates: number; budgetUnits: number }) {
    record(options, ['maxCandidates', 'budgetUnits']); integer(options.maxCandidates, 1, 5); integer(options.budgetUnits, 1, 1_000_000_000);
    this.maxCandidates = options.maxCandidates; this.budgetUnits = options.budgetUnits;
  }
  reserve(candidateId: string, reservedUnits: number): CandidateReservation {
    id(candidateId); integer(reservedUnits, 1, this.budgetUnits);
    ensure(!this.entries.has(candidateId), 'Candidate ID already attempted');
    ensure(this.entries.size < this.maxCandidates, 'Candidate limit exceeded');
    ensure(this.spentUnits + reservedUnits <= this.budgetUnits, 'Search budget exhausted');
    const reservation = snapshot({ candidateId, reservedUnits }); this.spentUnits += reservedUnits;
    this.entries.set(candidateId, { candidateId, reservedUnits, outcome: 'pending', evidenceRef: null });
    this.reservations.set(reservation, candidateId); return reservation;
  }
  finish(reservation: CandidateReservation, result: { outcome: 'failed' | 'no-improvement' | 'improved-fixture' | 'cancelled'; evidenceRef: string }): void {
    record(result, ['outcome', 'evidenceRef']); id(result.evidenceRef);
    ensure(['failed', 'no-improvement', 'improved-fixture', 'cancelled'].includes(result.outcome), 'Invalid search outcome');
    const candidateId = this.reservations.get(reservation); ensure(candidateId, 'Forged or consumed reservation');
    const entry = this.entries.get(candidateId)!;
    this.entries.set(candidateId, snapshot({ ...entry, ...result })); this.reservations.delete(reservation);
  }
  remainingBudgetUnits(): number { return this.budgetUnits - this.spentUnits; }
  archive(): SearchEntry[] { return structuredClone([...this.entries.values()]); }
}
