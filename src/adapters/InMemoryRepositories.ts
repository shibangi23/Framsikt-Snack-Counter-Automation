import { ConflictError, NotFoundError } from '../domain/errors';
import { OfficeId } from '../domain/offices';
import { isActive } from '../domain/stateMachine';
import { LedgerEntry, Refill, Volunteer } from '../domain/types';
import {
  LedgerRepository,
  OutboxItem,
  OutboxRepository,
  RefillRepository,
  VolunteerRepository,
} from '../ports/Repositories';

// All repositories hand out copies (structuredClone), so nobody can change
// stored state except through the repository methods.

export class InMemoryRefillRepository implements RefillRepository {
  private readonly rows = new Map<string, Refill>();

  async get(id: string): Promise<Refill> {
    const row = this.rows.get(id);
    if (!row) throw new NotFoundError(`Refill ${id} not found`);
    return structuredClone(row);
  }

  async list(): Promise<Refill[]> {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }

  async findActive(office: OfficeId): Promise<Refill | undefined> {
    const row = this.findActiveRow(office);
    return row && structuredClone(row);
  }

  async createIfNoActive(refill: Refill): Promise<{ refill: Refill; created: boolean }> {
    // WHY the await: it yields like a real database round trip, so concurrent
    // callers interleave in tests. The check and the insert below are synchronous,
    // so they cannot be split by another caller.
    await Promise.resolve();
    const existing = this.findActiveRow(refill.office);
    if (existing) return { refill: structuredClone(existing), created: false };
    this.rows.set(refill.id, structuredClone(refill));
    return { refill: structuredClone(refill), created: true };
  }

  async updateIfVersion(id: string, expectedVersion: number, mutate: (refill: Refill) => void): Promise<Refill> {
    await Promise.resolve(); // same reason as above: let concurrent callers interleave
    const current = this.rows.get(id);
    if (!current) throw new NotFoundError(`Refill ${id} not found`);
    if (current.version !== expectedVersion) throw new ConflictError(id, expectedVersion, current.version);
    // Mutate a copy: if mutate throws (e.g. IllegalTransitionError) nothing is stored.
    const next = structuredClone(current);
    mutate(next);
    next.version = current.version + 1;
    this.rows.set(id, next);
    return structuredClone(next);
  }

  private findActiveRow(office: OfficeId): Refill | undefined {
    return [...this.rows.values()].find((r) => r.office === office && isActive(r.state));
  }
}

export class InMemoryVolunteerRepository implements VolunteerRepository {
  private readonly rows = new Map<string, Volunteer>();

  constructor(initial: Volunteer[] = []) {
    for (const v of initial) this.rows.set(v.id, structuredClone(v));
  }

  async get(id: string): Promise<Volunteer> {
    const row = this.rows.get(id);
    if (!row) throw new NotFoundError(`Volunteer ${id} not found`);
    return structuredClone(row);
  }

  async list(): Promise<Volunteer[]> {
    return [...this.rows.values()].map((v) => structuredClone(v));
  }

  async save(volunteer: Volunteer): Promise<void> {
    this.rows.set(volunteer.id, structuredClone(volunteer));
  }
}

export class InMemoryLedgerRepository implements LedgerRepository {
  private rows: LedgerEntry[] = [];

  async add(entry: LedgerEntry): Promise<void> {
    this.rows.push(structuredClone(entry));
  }

  async removeReservation(refillId: string): Promise<void> {
    this.rows = this.rows.filter((e) => !(e.refillId === refillId && e.type === 'RESERVED'));
  }

  async list(): Promise<LedgerEntry[]> {
    return this.rows.map((e) => structuredClone(e));
  }
}

export class InMemoryOutboxRepository implements OutboxRepository {
  private readonly rows = new Map<string, OutboxItem>();

  async get(key: string): Promise<OutboxItem | undefined> {
    const row = this.rows.get(key);
    return row && structuredClone(row);
  }

  async save(item: OutboxItem): Promise<void> {
    this.rows.set(item.key, structuredClone(item));
  }

  async list(): Promise<OutboxItem[]> {
    return [...this.rows.values()].map((i) => structuredClone(i));
  }
}
