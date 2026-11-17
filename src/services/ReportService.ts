import { Money, RateSnapshot, sum, toNok } from '../domain/money';
import { OfficeId, OFFICES } from '../domain/offices';
import { PurchaseItem } from '../domain/types';
import { RefillRepository } from '../ports/Repositories';
import { BudgetLedger } from './BudgetLedger';

export interface OfficeReport {
  office: OfficeId;
  budget: Money;
  spent: Money;
  reserved: Money;
}

export interface MonthlyReport {
  monthKey: string;
  offices: OfficeReport[];
  /** SPENT across both offices, converted to NOK with the rate below. */
  combinedSpentNok: Money;
  rate: RateSnapshot;
  topItems: PurchaseItem[];
}

export class ReportService {
  constructor(
    private readonly ledger: BudgetLedger,
    private readonly refills: RefillRepository,
  ) {}

  async monthly(monthKey: string, rate: RateSnapshot): Promise<MonthlyReport> {
    const offices: OfficeReport[] = [];
    for (const office of Object.values(OFFICES)) {
      const totals = await this.ledger.totals(office.id, monthKey);
      offices.push({ office: office.id, budget: office.monthlyBudget, ...totals });
    }

    // WHY a rate snapshot: management needs one number, but the native totals stay the
    // source of truth. The report states which rate and date produced the NOK figure.
    const combinedSpentNok = sum(offices.map((o) => toNok(o.spent, rate)), 'NOK');

    return { monthKey, offices, combinedSpentNok, rate, topItems: await this.topItems(monthKey) };
  }

  private async topItems(monthKey: string, limit = 5): Promise<PurchaseItem[]> {
    const spentRefillIds = new Set(
      (await this.ledger.entriesFor(monthKey)).filter((e) => e.type === 'SPENT').map((e) => e.refillId),
    );
    const quantities = new Map<string, number>();
    for (const refill of await this.refills.list()) {
      if (!spentRefillIds.has(refill.id)) continue;
      for (const item of refill.purchase?.items ?? []) {
        quantities.set(item.name, (quantities.get(item.name) ?? 0) + item.quantity);
      }
    }
    return [...quantities.entries()]
      .map(([name, quantity]) => ({ name, quantity }))
      .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name))
      .slice(0, limit);
  }
}
