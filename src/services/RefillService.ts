import { randomUUID } from 'node:crypto';
import {
  BudgetExceededError,
  ClaimRejectedError,
  ConflictError,
  CurrencyMismatchError,
  IllegalTransitionError,
  NotAllowedError,
} from '../domain/errors';
import { Currency, Money } from '../domain/money';
import { OfficeId, OFFICES } from '../domain/offices';
import { newRefill, transition } from '../domain/stateMachine';
import { addMs, DAY, HOUR } from '../domain/time';
import { PurchaseItem, Refill } from '../domain/types';
import { ChatPort } from '../ports/ChatPort';
import { Clock } from '../ports/Clock';
import { HrStatus } from '../ports/HrPort';
import { RefillRepository, VolunteerRepository } from '../ports/Repositories';
import { BudgetLedger } from './BudgetLedger';
import { HrOutbox } from './HrOutbox';
import { rankCandidates, RankFn } from './Picker';

export interface RefillConfig {
  offerWindowMs: number;
  claimWindowMs: number;
  hrNudgeAfterMs: number;
  unreimbursedLimit: Record<Currency, number>;
}

export const DEFAULT_CONFIG: RefillConfig = {
  offerWindowMs: 2 * HOUR,
  claimWindowMs: 24 * HOUR,
  hrNudgeAfterMs: 10 * DAY,
  unreimbursedLimit: { NOK: 300_000, INR: 750_000 },
};

export interface RefillDeps {
  refills: RefillRepository;
  volunteers: VolunteerRepository;
  ledger: BudgetLedger;
  outbox: HrOutbox;
  chat: ChatPort;
  clock: Clock;
  config?: Partial<RefillConfig>;
  rank?: RankFn;
}

interface OfferOptions {
  actor: string;
  reason: string;
  /** Volunteer to exclude from this refill (declined, timed out or expired). */
  exclude?: string;
  /** CLAIMED -> EXPIRED -> OFFERED in the same atomic update. */
  expire?: boolean;
}

export class RefillService {
  private readonly config: RefillConfig;
  private readonly rank: RankFn;

  constructor(private readonly deps: RefillDeps) {
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    this.rank = deps.rank ?? rankCandidates;
  }

  // WHY idempotent: five people may notice the same empty box. While a refill is
  // active, every report returns that refill instead of starting a second purchase.
  async reportEmpty(office: OfficeId, reporterId: string): Promise<Refill> {
    const candidate = newRefill(randomUUID(), office, reporterId, this.deps.clock.now());
    const { refill, created } = await this.deps.refills.createIfNoActive(candidate);
    if (!created) return refill;
    return this.offerToNext(refill, { actor: reporterId, reason: 'box reported empty' });
  }

  // WHY atomic: two taps on "claim" (or a claim racing a timeout) must produce exactly
  // one CLAIMED refill. updateIfVersion fails for everyone except the first writer.
  async claim(refillId: string, volunteerId: string): Promise<{ refill: Refill; budgetWarning: boolean }> {
    const { refills, clock, chat, ledger } = this.deps;
    const now = clock.now();
    const refill = await refills.get(refillId);
    if (refill.state !== 'OFFERED') throw new ClaimRejectedError(`Refill is ${refill.state}, not open for claiming`);
    if (refill.offeredTo !== volunteerId) throw new ClaimRejectedError(`Refill is not currently offered to ${volunteerId}`);

    let budget: { warning: boolean };
    try {
      budget = await ledger.checkReservation(refill);
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        await chat.send(
          { kind: 'manager', office: refill.office },
          `Budget limit: ${volunteerId} wants to refill ${refill.office} (refill ${refillId}). ${error.message}.`,
        );
      }
      throw error; // the refill stays OFFERED
    }

    let claimed: Refill;
    try {
      claimed = await refills.updateIfVersion(refillId, refill.version, (r) => {
        transition(r, 'CLAIMED', now, volunteerId, 'accepted offer');
        r.claimedBy = volunteerId;
        r.claimedAt = now;
        r.claimDeadline = addMs(now, this.config.claimWindowMs);
        r.reminderSent = false;
        r.offerExpiresAt = null;
      });
    } catch (error) {
      if (error instanceof ConflictError) {
        throw new ClaimRejectedError('Someone else changed this refill first; your claim did not go through');
      }
      throw error;
    }
    await ledger.reserve(claimed);
    await chat.send(
      { kind: 'volunteer', volunteerId },
      `Thanks! The refill is yours. Please buy snacks and upload the receipt before ${claimed.claimDeadline!.toISOString()}.`,
    );
    return { refill: claimed, budgetWarning: budget.warning };
  }

  async decline(refillId: string, volunteerId: string): Promise<Refill> {
    const refill = await this.deps.refills.get(refillId);
    if (refill.state !== 'OFFERED' || refill.offeredTo !== volunteerId) {
      throw new NotAllowedError(`Refill is not currently offered to ${volunteerId}`);
    }
    return this.offerToNext(refill, { actor: volunteerId, reason: "declined: I can't, pass it on", exclude: volunteerId });
  }

  async recordPurchase(
    refillId: string,
    volunteerId: string,
    amount: Money,
    receiptRef: string,
    description: string,
    items: PurchaseItem[] = [],
  ): Promise<{ refill: Refill; overReservation: boolean }> {
    const { refills, clock, ledger, outbox } = this.deps;
    const now = clock.now();
    const refill = await refills.get(refillId);
    if (refill.state !== 'CLAIMED') throw new IllegalTransitionError(refill.state, 'PURCHASED');
    if (refill.claimedBy !== volunteerId) throw new NotAllowedError(`Only ${refill.claimedBy} can record this purchase`);
    // WHY: the office budget is in one currency; a receipt in another would corrupt the ledger.
    const officeCurrency = OFFICES[refill.office].currency;
    if (amount.currency !== officeCurrency) throw new CurrencyMismatchError(officeCurrency, amount.currency);

    const purchased = await refills.updateIfVersion(refillId, refill.version, (r) => {
      transition(r, 'PURCHASED', now, volunteerId, 'receipt uploaded');
      r.purchase = { volunteerId, amount, receiptRef, description, items, at: now };
    });
    const { overReservation } = await ledger.settle(refillId, refill.office, amount);
    await outbox.enqueue({ idempotencyKey: refillId, employeeId: volunteerId, amount, description, receiptRef });
    return { refill: purchased, overReservation };
  }

  async handleHrStatus(refillId: string, status: HrStatus): Promise<Refill> {
    const { refills, clock, chat } = this.deps;
    const refill = await refills.get(refillId);
    const target = status === 'APPROVED' ? 'REIMBURSED' : 'REJECTED_BY_HR';
    // WHY: HR may resend the same status; a repeat is a no-op, not an error.
    if (refill.state === target) return refill;

    const updated = await refills.updateIfVersion(refillId, refill.version, (r) => {
      transition(r, target, clock.now(), 'hr', `HR ${status}`);
    });
    if (status === 'REJECTED') {
      // The ledger keeps the SPENT entry: the snacks were bought, so the money was spent.
      await chat.send(
        { kind: 'manager', office: refill.office },
        `HR rejected the claim for refill ${refillId} by ${refill.purchase?.volunteerId}. Please follow up with them.`,
      );
    }
    return updated;
  }

  // WHY one tick: all time-based work lives in one place and depends only on the Clock.
  // Every step checks state and flags first, so calling tick() twice does no harm.
  async tick(): Promise<void> {
    await this.deps.outbox.flush();
    for (const refill of await this.deps.refills.list()) {
      try {
        await this.tickRefill(refill);
      } catch (error) {
        // WHY skip conflicts: someone changed the refill while we worked on it;
        // the next tick looks at the fresh version.
        if (!(error instanceof ConflictError)) throw error;
      }
    }
  }

  private async tickRefill(refill: Refill): Promise<void> {
    const now = this.deps.clock.now().getTime();
    if (refill.state === 'OFFERED') {
      if (refill.offeredTo === null) {
        await this.offerToNext(refill, { actor: 'system', reason: 'retry: nobody was available' });
      } else if (now >= refill.offerExpiresAt!.getTime()) {
        await this.offerToNext(refill, { actor: 'system', reason: 'offer timed out', exclude: refill.offeredTo });
      }
    } else if (refill.state === 'CLAIMED') {
      if (now >= refill.claimDeadline!.getTime()) {
        await this.expireClaim(refill);
      } else if (!refill.reminderSent && now >= refill.claimedAt!.getTime() + this.config.claimWindowMs / 2) {
        await this.sendReminder(refill);
      }
    } else if (refill.state === 'PURCHASED' && (await this.deps.outbox.isSent(refill.id))) {
      await this.deps.refills.updateIfVersion(refill.id, refill.version, (r) => {
        transition(r, 'SUBMITTED_TO_HR', new Date(now), 'system', 'claim delivered to HR');
        r.submittedAt = new Date(now);
      });
    } else if (
      refill.state === 'SUBMITTED_TO_HR' &&
      !refill.hrNudgeSent &&
      now >= refill.submittedAt!.getTime() + this.config.hrNudgeAfterMs
    ) {
      await this.nudgeAboutSlowHr(refill);
    }
  }

  // WHY: HR approves within 10 days; anything slower means the volunteer is out of pocket
  // and someone should chase it. Marked first so it is sent at most once.
  private async nudgeAboutSlowHr(refill: Refill): Promise<void> {
    await this.deps.refills.updateIfVersion(refill.id, refill.version, (r) => {
      r.hrNudgeSent = true;
    });
    await this.deps.chat.send(
      { kind: 'manager', office: refill.office },
      `The HR claim for refill ${refill.id} by ${refill.purchase?.volunteerId} has waited over 10 days. Please chase HR.`,
    );
  }

  // WHY a lease: a claim nobody completes would otherwise block the office forever.
  private async expireClaim(refill: Refill): Promise<void> {
    const volunteerId = refill.claimedBy!;
    await this.offerToNext(refill, { actor: 'system', reason: 'claim deadline passed', exclude: volunteerId, expire: true });
    await this.deps.ledger.release(refill.id);
    const volunteer = await this.deps.volunteers.get(volunteerId);
    await this.deps.volunteers.save({ ...volunteer, expiryCount: volunteer.expiryCount + 1 });
    await this.deps.chat.send(
      { kind: 'volunteer', volunteerId },
      'The refill deadline passed, so we passed it on to someone else. No problem!',
    );
  }

  private async sendReminder(refill: Refill): Promise<void> {
    // WHY mark first, then send: a reminder is better lost than sent twice.
    await this.deps.refills.updateIfVersion(refill.id, refill.version, (r) => {
      r.reminderSent = true;
    });
    await this.deps.chat.send(
      { kind: 'volunteer', volunteerId: refill.claimedBy! },
      `Reminder: please buy snacks and upload the receipt before ${refill.claimDeadline!.toISOString()}.`,
    );
  }

  /** Offers the refill to the best-ranked eligible volunteer (or to nobody). */
  private async offerToNext(refill: Refill, options: OfferOptions): Promise<Refill> {
    const { refills, volunteers, chat, clock } = this.deps;
    const now = clock.now();
    const excluded = options.exclude ? [...refill.excluded, options.exclude] : refill.excluded;
    const ranked = this.rank({
      refill: { office: refill.office, excluded },
      volunteers: await volunteers.list(),
      refills: await refills.list(),
      now,
      unreimbursedLimit: this.config.unreimbursedLimit,
    });
    const next = ranked[0] ?? null;

    // WHY: when we are already waiting for someone to become available, a retry
    // that still finds nobody changes nothing and must not spam the channel.
    const alreadyWaiting = refill.state === 'OFFERED' && refill.offeredTo === null;
    if (!next && alreadyWaiting) return refill;

    const updated = await refills.updateIfVersion(refill.id, refill.version, (r) => {
      if (options.expire) {
        transition(r, 'EXPIRED', now, options.actor, options.reason);
        r.claimedBy = null;
        r.claimedAt = null;
        r.claimDeadline = null;
      }
      if (r.state !== 'OFFERED') transition(r, 'OFFERED', now, options.actor, options.reason);
      r.excluded = excluded;
      r.offeredTo = next ? next.id : null;
      r.offerExpiresAt = next ? addMs(now, this.config.offerWindowMs) : null;
    });

    if (next) {
      const hours = this.config.offerWindowMs / HOUR;
      await chat.send(
        { kind: 'volunteer', volunteerId: next.id },
        `The snack box in ${refill.office} is empty. Can you refill it? Reply "claim" or "I can't, pass it on" within ${hours} hours.`,
      );
    } else {
      await chat.send(
        { kind: 'channel', office: refill.office },
        `The snack box in ${refill.office} is empty and no volunteer is available right now. We will keep trying.`,
      );
    }
    return updated;
  }
}
