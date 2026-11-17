import { Money } from './money';
import { OfficeId } from './offices';

export type Presence = 'IN_OFFICE' | 'REMOTE' | 'ON_LEAVE';

/** The volunteer id is also their HR employee id. */
export interface Volunteer {
  id: string;
  homeOffice: OfficeId;
  // WHY separate from homeOffice: a visitor can refill the box where they are this week.
  currentOffice: OfficeId;
  presence: Presence;
  expiryCount: number;
}

export type RefillState =
  | 'REPORTED_EMPTY'
  | 'OFFERED'
  | 'CLAIMED'
  | 'EXPIRED'
  | 'PURCHASED'
  | 'SUBMITTED_TO_HR'
  | 'REIMBURSED'
  | 'CANCELLED'
  | 'REJECTED_BY_HR';

export interface HistoryEntry {
  from: RefillState;
  to: RefillState;
  at: Date;
  actor: string;
  reason: string;
}

export interface PurchaseItem {
  name: string;
  quantity: number;
}

export interface Purchase {
  volunteerId: string;
  amount: Money;
  receiptRef: string;
  description: string;
  items: PurchaseItem[];
  at: Date;
}

export interface Refill {
  id: string;
  office: OfficeId;
  state: RefillState;
  version: number;
  reportedBy: string;
  reportedAt: Date;
  offeredTo: string | null;
  offerExpiresAt: Date | null;
  /** Volunteers who declined or timed out on THIS refill. */
  excluded: string[];
  claimedBy: string | null;
  claimedAt: Date | null;
  claimDeadline: Date | null;
  reminderSent: boolean;
  managerOverride: boolean;
  purchase: Purchase | null;
  submittedAt: Date | null;
  hrNudgeSent: boolean;
  history: HistoryEntry[];
}

export interface LedgerEntry {
  office: OfficeId;
  monthKey: string;
  amount: Money;
  type: 'RESERVED' | 'SPENT';
  refillId: string;
}
