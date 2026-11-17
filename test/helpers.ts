import { createFakeSystem } from '../src/createSystem';
import { OfficeId } from '../src/domain/offices';
import { Volunteer } from '../src/domain/types';
import { RefillConfig } from '../src/services/RefillService';

/** A Monday morning in March 2026 (UTC). */
export const START = new Date('2026-03-02T08:00:00Z');

export function volunteer(id: string, homeOffice: OfficeId, overrides: Partial<Volunteer> = {}): Volunteer {
  return { id, homeOffice, currentOffice: homeOffice, presence: 'IN_OFFICE', expiryCount: 0, ...overrides };
}

/** n volunteers with ids like osl-01, osl-02 ... */
export function team(office: OfficeId, n: number): Volunteer[] {
  const prefix = office === 'OSLO' ? 'osl' : 'blr';
  return Array.from({ length: n }, (_, i) => volunteer(`${prefix}-${String(i + 1).padStart(2, '0')}`, office));
}

export function setup(volunteers: Volunteer[], config?: Partial<RefillConfig>, start = START) {
  return createFakeSystem({ start, volunteers, config });
}
