import { Currency } from '../domain/money';
import { OfficeId } from '../domain/offices';
import { DAY } from '../domain/time';
import { Refill, Volunteer } from '../domain/types';

export interface PickerInput {
  refill: { office: OfficeId; excluded: readonly string[] };
  volunteers: Volunteer[];
  /** All refills, used to compute each volunteer's recent load and unreimbursed money. */
  refills: Refill[];
  now: Date;
  /** Per-currency cap in minor units on money waiting at HR. */
  unreimbursedLimit: Record<Currency, number>;
}

export type RankFn = (input: PickerInput) => Volunteer[];

interface Stats {
  recentRefills: number;
  lastRefillAt: number; // 0 = never refilled, which sorts as "longest ago"
  unreimbursed: Record<Currency, number>;
}

function statsFor(volunteerId: string, refills: Refill[], now: Date): Stats {
  const windowStart = now.getTime() - 30 * DAY;
  const stats: Stats = { recentRefills: 0, lastRefillAt: 0, unreimbursed: { NOK: 0, INR: 0 } };
  for (const refill of refills) {
    const purchase = refill.purchase;
    if (!purchase || purchase.volunteerId !== volunteerId) continue;
    const at = purchase.at.getTime();
    if (at > windowStart) stats.recentRefills++;
    stats.lastRefillAt = Math.max(stats.lastRefillAt, at);
    if (refill.state === 'SUBMITTED_TO_HR') stats.unreimbursed[purchase.amount.currency] += purchase.amount.amount;
  }
  return stats;
}

/**
 * Pure function: returns every eligible volunteer, best candidate first.
 * Returning the full list makes "offer to the next one" trivial.
 */
export function rankCandidates(input: PickerInput): Volunteer[] {
  const { refill, now, unreimbursedLimit } = input;
  const stats = new Map(input.volunteers.map((v) => [v.id, statsFor(v.id, input.refills, now)]));
  const statsOf = (v: Volunteer): Stats => stats.get(v.id)!;

  const eligible = input.volunteers.filter(
    (v) =>
      // WHY currentOffice: a visitor can physically refill the box where they are this week.
      v.currentOffice === refill.office &&
      // WHY: people on holiday should never be pinged.
      v.presence !== 'ON_LEAVE' &&
      // WHY: someone who passed on or ignored THIS refill should not get it again.
      !refill.excluded.includes(v.id) &&
      // WHY: cap how much of their own money one person has waiting at HR.
      (Object.keys(unreimbursedLimit) as Currency[]).every((c) => statsOf(v).unreimbursed[c] < unreimbursedLimit[c]),
  );

  // WHY this order: spread the work (fewest recent refills), then rotate (longest since
  // last refill), then prefer people who finish what they claim, then id for determinism.
  return eligible.sort(
    (a, b) =>
      statsOf(a).recentRefills - statsOf(b).recentRefills ||
      statsOf(a).lastRefillAt - statsOf(b).lastRefillAt ||
      a.expiryCount - b.expiryCount ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
