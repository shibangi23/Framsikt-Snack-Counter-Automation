import { IllegalTransitionError } from './errors';
import { OfficeId } from './offices';
import { Refill, RefillState } from './types';

// WHY one table: every legal move is visible in one place, so a bug
// (for example re-offering a refill that was already bought) fails loudly
// instead of quietly corrupting state.
export const TRANSITIONS: Record<RefillState, readonly RefillState[]> = {
  REPORTED_EMPTY: ['OFFERED', 'CANCELLED'],
  OFFERED: ['CLAIMED', 'CANCELLED'],
  CLAIMED: ['PURCHASED', 'EXPIRED', 'CANCELLED'],
  // EXPIRED is transient: it is always followed by OFFERED in the same operation.
  EXPIRED: ['OFFERED'],
  PURCHASED: ['SUBMITTED_TO_HR'],
  SUBMITTED_TO_HR: ['REIMBURSED', 'REJECTED_BY_HR'],
  REIMBURSED: [],
  CANCELLED: [],
  REJECTED_BY_HR: [],
};

// WHY "active": while the box is still empty there must be exactly one refill
// owning it, so two people never buy on the same day.
export const ACTIVE_STATES: readonly RefillState[] = ['REPORTED_EMPTY', 'OFFERED', 'CLAIMED', 'EXPIRED'];

export function isActive(state: RefillState): boolean {
  return ACTIVE_STATES.includes(state);
}

/** Moves the refill to `to` (mutating it) and appends an audit entry. */
export function transition(refill: Refill, to: RefillState, at: Date, actor: string, reason: string): void {
  if (!TRANSITIONS[refill.state].includes(to)) {
    throw new IllegalTransitionError(refill.state, to);
  }
  refill.history.push({ from: refill.state, to, at, actor, reason });
  refill.state = to;
}

export function newRefill(id: string, office: OfficeId, reportedBy: string, reportedAt: Date): Refill {
  return {
    id,
    office,
    state: 'REPORTED_EMPTY',
    version: 0,
    reportedBy,
    reportedAt,
    offeredTo: null,
    offerExpiresAt: null,
    excluded: [],
    claimedBy: null,
    claimedAt: null,
    claimDeadline: null,
    reminderSent: false,
    managerOverride: false,
    purchase: null,
    submittedAt: null,
    hrNudgeSent: false,
    history: [],
  };
}
