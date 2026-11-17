import { OfficeId } from '../domain/offices';
import { LedgerEntry, Refill, Volunteer } from '../domain/types';
import { HrClaim } from './HrPort';

export interface RefillRepository {
  get(id: string): Promise<Refill>;
  list(): Promise<Refill[]>;
  findActive(office: OfficeId): Promise<Refill | undefined>;
  // WHY atomic: two "box is empty" reports at the same moment must not open two refills.
  createIfNoActive(refill: Refill): Promise<{ refill: Refill; created: boolean }>;
  // WHY compare-and-set: the caller says which version it read. If anyone changed the
  // refill since, this throws ConflictError instead of overwriting their change.
  updateIfVersion(id: string, expectedVersion: number, mutate: (refill: Refill) => void): Promise<Refill>;
}

export interface VolunteerRepository {
  get(id: string): Promise<Volunteer>;
  list(): Promise<Volunteer[]>;
  save(volunteer: Volunteer): Promise<void>;
}

export interface LedgerRepository {
  add(entry: LedgerEntry): Promise<void>;
  removeReservation(refillId: string): Promise<void>;
  list(): Promise<LedgerEntry[]>;
}

export interface OutboxItem {
  key: string;
  claim: HrClaim;
  status: 'PENDING' | 'SENT';
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
}

export interface OutboxRepository {
  get(key: string): Promise<OutboxItem | undefined>;
  save(item: OutboxItem): Promise<void>;
  list(): Promise<OutboxItem[]>;
}
