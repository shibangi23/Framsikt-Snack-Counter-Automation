import { DuplicateClaimError, HrClaim, HrPort, HrStatus } from '../ports/HrPort';

/** Stores claims by idempotency key. Can be told to fail, approve or reject. */
export class FakeHr implements HrPort {
  readonly claims = new Map<string, HrClaim>();
  submitCalls = 0;
  duplicateAttempts = 0;
  private failuresLeft = 0;

  /** Plays the role of HR's status webhook. createFakeSystem points it at handleHrStatus. */
  onStatus: (refillId: string, status: HrStatus) => Promise<unknown> = async () => undefined;

  failNextSubmits(count: number): void {
    this.failuresLeft = count;
  }

  async submitClaim(claim: HrClaim): Promise<void> {
    this.submitCalls++;
    await Promise.resolve(); // behave like a network call
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error('HR system unavailable');
    }
    // Like the real HR system: the same key twice is refused.
    if (this.claims.has(claim.idempotencyKey)) {
      this.duplicateAttempts++;
      throw new DuplicateClaimError(claim.idempotencyKey);
    }
    this.claims.set(claim.idempotencyKey, claim);
  }

  approve(key: string): Promise<unknown> {
    return this.decide(key, 'APPROVED');
  }

  reject(key: string): Promise<unknown> {
    return this.decide(key, 'REJECTED');
  }

  private async decide(key: string, status: HrStatus): Promise<unknown> {
    if (!this.claims.has(key)) throw new Error(`HR has no claim ${key}`);
    return this.onStatus(key, status);
  }
}
