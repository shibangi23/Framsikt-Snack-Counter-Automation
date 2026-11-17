import { Money } from '../domain/money';

export interface HrClaim {
  /** The refill id: one refill = one receipt = one claim. */
  idempotencyKey: string;
  employeeId: string;
  amount: Money;
  description: string;
  receiptRef: string;
}

export type HrStatus = 'APPROVED' | 'REJECTED';

export interface HrPort {
  submitClaim(claim: HrClaim): Promise<void>;
}

/** HR refuses a second claim with the same idempotency key. */
export class DuplicateClaimError extends Error {
  constructor(key: string) {
    super(`HR already has a claim with key ${key}`);
    this.name = 'DuplicateClaimError';
  }
}
