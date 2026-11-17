import { BudgetExceededError } from '../domain/errors';
import { add, compare, format, Money, sum } from '../domain/money';
import { OfficeId, OFFICES } from '../domain/offices';
import { monthKey } from '../domain/time';
import { LedgerEntry, Refill } from '../domain/types';
import { Clock } from '../ports/Clock';
import { LedgerRepository, RefillRepository } from '../ports/Repositories';

export interface MonthTotals {
  spent: Money;
  reserved: Money;
}

export class BudgetLedger {
  constructor(
    private readonly entries: LedgerRepository,
    private readonly refills: RefillRepository,
    private readonly clock: Clock,
  ) {}

  /**
   * Throws BudgetExceededError if reserving for this refill would go over the office's
   * monthly budget (unless a manager approved an override). Writes nothing.
   *
   * WHY separate from reserve(): the claim checks the budget, then wins the atomic
   * update, and only the winner writes the reservation. Losers never touch the ledger.
   */
  async checkReservation(refill: Refill): Promise<{ warning: boolean }> {
    const office = OFFICES[refill.office];
    const month = monthKey(this.clock.now(), office.timezone);
    const { spent, reserved } = await this.totals(refill.office, month);
    const after = add(add(spent, reserved), office.reserveAmount);
    if (compare(after, office.monthlyBudget) > 0 && !refill.managerOverride) {
      throw new BudgetExceededError(
        `${refill.office} would reach ${format(after)} of ${format(office.monthlyBudget)} in ${month}; a manager override is needed`,
      );
    }
    // WHY 80%: warn early so the manager is not surprised at month end. Integer math, no floats.
    return { warning: after.amount * 100 >= office.monthlyBudget.amount * 80 };
  }

  async reserve(refill: Refill): Promise<void> {
    const office = OFFICES[refill.office];
    await this.entries.add({
      office: office.id,
      monthKey: monthKey(this.clock.now(), office.timezone),
      amount: office.reserveAmount,
      type: 'RESERVED',
      refillId: refill.id,
    });
  }

  /** Replaces the reservation with the actual SPENT amount, in the month of purchase. */
  async settle(refillId: string, office: OfficeId, actual: Money): Promise<{ overReservation: boolean }> {
    const reservation = (await this.entries.list()).find((e) => e.refillId === refillId && e.type === 'RESERVED');
    await this.entries.removeReservation(refillId);
    await this.entries.add({
      office,
      monthKey: monthKey(this.clock.now(), OFFICES[office].timezone),
      amount: actual,
      type: 'SPENT',
      refillId,
    });
    // WHY record anyway: the snacks are bought; we cannot refuse a receipt, only flag it.
    return { overReservation: reservation !== undefined && compare(actual, reservation.amount) > 0 };
  }

  async release(refillId: string): Promise<void> {
    await this.entries.removeReservation(refillId);
  }

  // WHY an explicit override: going over budget is a manager's decision, not the bot's.
  async approveOverride(refillId: string): Promise<void> {
    const refill = await this.refills.get(refillId);
    await this.refills.updateIfVersion(refillId, refill.version, (r) => {
      r.managerOverride = true;
    });
  }

  async entriesFor(month: string): Promise<LedgerEntry[]> {
    return (await this.entries.list()).filter((e) => e.monthKey === month);
  }

  async totals(office: OfficeId, month: string): Promise<MonthTotals> {
    const currency = OFFICES[office].currency;
    const mine = (await this.entriesFor(month)).filter((e) => e.office === office);
    return {
      spent: sum(mine.filter((e) => e.type === 'SPENT').map((e) => e.amount), currency),
      reserved: sum(mine.filter((e) => e.type === 'RESERVED').map((e) => e.amount), currency),
    };
  }
}
