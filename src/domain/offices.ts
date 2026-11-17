import { Currency, Money, money } from './money';

export type OfficeId = 'OSLO' | 'BENGALURU';

export interface OfficeConfig {
  id: OfficeId;
  currency: Currency;
  timezone: string;
  monthlyBudget: Money;
  // WHY a reserve: when someone commits to buy, we hold roughly the largest typical
  // purchase so a second claim cannot also count on the same remaining budget.
  reserveAmount: Money;
}

export const OFFICES: Record<OfficeId, OfficeConfig> = {
  OSLO: {
    id: 'OSLO',
    currency: 'NOK',
    timezone: 'Europe/Oslo',
    monthlyBudget: money(600_000, 'NOK'),
    reserveAmount: money(120_000, 'NOK'),
  },
  BENGALURU: {
    id: 'BENGALURU',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    monthlyBudget: money(1_500_000, 'INR'),
    reserveAmount: money(300_000, 'INR'),
  },
};
