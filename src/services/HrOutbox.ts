import { addMs, HOUR, MINUTE } from '../domain/time';
import { Clock } from '../ports/Clock';
import { DuplicateClaimError, HrClaim, HrPort } from '../ports/HrPort';
import { OutboxRepository } from '../ports/Repositories';

// WHY exponential backoff: if HR is down, retrying every minute forever only adds load.
// 1, 2, 4, 8 ... minutes, capped at 6 hours.
export function backoffMs(attempts: number): number {
  return Math.min(MINUTE * 2 ** (attempts - 1), 6 * HOUR);
}

// WHY an outbox: the purchase is recorded first, and the HR send happens later and is
// retried until it works. A failed HR call never loses a claim or blocks the volunteer.
export class HrOutbox {
  private flushing = false;

  constructor(
    private readonly items: OutboxRepository,
    private readonly hr: HrPort,
    private readonly clock: Clock,
  ) {}

  // WHY the refill id as key: one refill = one receipt = one HR claim, so enqueueing
  // twice (or retrying) can never produce a second claim.
  async enqueue(claim: HrClaim): Promise<void> {
    if (await this.items.get(claim.idempotencyKey)) return;
    await this.items.save({
      key: claim.idempotencyKey,
      claim,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: this.clock.now(),
      lastError: null,
    });
  }

  async isSent(key: string): Promise<boolean> {
    return (await this.items.get(key))?.status === 'SENT';
  }

  async flush(): Promise<void> {
    // WHY: two overlapping flushes would both see the same item as pending and send it twice.
    if (this.flushing) return;
    this.flushing = true;
    try {
      const now = this.clock.now();
      for (const item of await this.items.list()) {
        if (item.status !== 'PENDING' || item.nextAttemptAt.getTime() > now.getTime()) continue;
        try {
          await this.hr.submitClaim(item.claim);
          await this.items.save({ ...item, status: 'SENT', attempts: item.attempts + 1, lastError: null });
        } catch (error) {
          if (error instanceof DuplicateClaimError) {
            // HR already has this claim (e.g. an earlier reply was lost), so it counts as sent.
            await this.items.save({ ...item, status: 'SENT', attempts: item.attempts + 1 });
            continue;
          }
          const attempts = item.attempts + 1;
          await this.items.save({ ...item, attempts, nextAttemptAt: addMs(now, backoffMs(attempts)), lastError: String(error) });
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
