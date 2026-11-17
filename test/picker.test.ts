import { describe, expect, it } from 'vitest';
import { money } from '../src/domain/money';
import { newRefill } from '../src/domain/stateMachine';
import { DAY } from '../src/domain/time';
import { Refill, RefillState } from '../src/domain/types';
import { PickerInput, rankCandidates } from '../src/services/Picker';
import { DEFAULT_CONFIG } from '../src/services/RefillService';
import { setup, START, team, volunteer } from './helpers';

/** A past refill bought by `volunteerId`, `daysAgo` days before START. */
function pastRefill(volunteerId: string, daysAgo: number, state: RefillState = 'REIMBURSED', amount = money(50_000, 'NOK')): Refill {
  const at = new Date(START.getTime() - daysAgo * DAY);
  const refill = newRefill(`past-${volunteerId}-${daysAgo}`, 'OSLO', 'emp', at);
  refill.state = state;
  refill.purchase = { volunteerId, amount, receiptRef: 'r', description: 'snacks', items: [], at };
  return refill;
}

function rank(overrides: Partial<PickerInput>): string[] {
  return rankCandidates({
    refill: { office: 'OSLO', excluded: [] },
    volunteers: [],
    refills: [],
    now: START,
    unreimbursedLimit: DEFAULT_CONFIG.unreimbursedLimit,
    ...overrides,
  }).map((v) => v.id);
}

describe('Picker eligibility', () => {
  it('skips ON_LEAVE, wrong office, over-limit and already-declined volunteers', () => {
    const volunteers = [
      volunteer('ok', 'OSLO'),
      volunteer('remote', 'OSLO', { presence: 'REMOTE' }),
      volunteer('leave', 'OSLO', { presence: 'ON_LEAVE' }),
      volunteer('away', 'OSLO', { currentOffice: 'BENGALURU' }),
      volunteer('owed', 'OSLO'),
      volunteer('declined', 'OSLO'),
    ];
    // 3,000 NOK waiting at HR = exactly the limit, so "owed" is not below it.
    const refills = [pastRefill('owed', 40, 'SUBMITTED_TO_HR', money(300_000, 'NOK'))];
    expect(rank({ volunteers, refills, refill: { office: 'OSLO', excluded: ['declined'] } })).toEqual(['ok', 'remote']);
  });

  it('a Bengaluru volunteer visiting Oslo is eligible for Oslo and not for Bengaluru', () => {
    const visitor = volunteer('blr-visitor', 'BENGALURU', { currentOffice: 'OSLO' });
    expect(rank({ volunteers: [visitor], refill: { office: 'OSLO', excluded: [] } })).toEqual(['blr-visitor']);
    expect(rank({ volunteers: [visitor], refill: { office: 'BENGALURU', excluded: [] } })).toEqual([]);
  });

  it('only counts money in SUBMITTED_TO_HR, per currency', () => {
    const volunteers = [volunteer('v', 'OSLO')];
    const reimbursed = [pastRefill('v', 5, 'REIMBURSED', money(900_000, 'NOK'))];
    expect(rank({ volunteers, refills: reimbursed })).toEqual(['v']);
    const inrOwed = [pastRefill('v', 5, 'SUBMITTED_TO_HR', money(750_000, 'INR'))];
    expect(rank({ volunteers, refills: inrOwed })).toEqual([]);
  });
});

describe('Picker ranking', () => {
  it('orders by recent refills, then longest since last, then expiries, then id', () => {
    const volunteers = [
      volunteer('p', 'OSLO'), // 2 recent refills
      volunteer('q', 'OSLO'), // 1 recent, 20 days ago
      volunteer('r', 'OSLO'), // 1 recent, 5 days ago
      volunteer('s', 'OSLO', { expiryCount: 2 }), // never refilled, but 2 expiries
      volunteer('u', 'OSLO'), // never refilled
      volunteer('t', 'OSLO'), // never refilled (same as u, wins on id)
      volunteer('v', 'OSLO'), // one refill 40 days ago: not recent, but more recent than "never"
    ];
    const refills = [pastRefill('p', 3), pastRefill('p', 10), pastRefill('q', 20), pastRefill('r', 5), pastRefill('v', 40)];
    expect(rank({ volunteers, refills })).toEqual(['t', 'u', 's', 'v', 'q', 'r', 'p']);
  });

  it('fairness: 20 volunteers and 60 refills give a spread of at most 1', async () => {
    const sys = setup(team('OSLO', 20));
    for (let i = 0; i < 60; i++) {
      const refill = await sys.service.reportEmpty('OSLO', 'emp');
      await sys.service.claim(refill.id, refill.offeredTo!);
      await sys.service.recordPurchase(refill.id, refill.offeredTo!, money(10_000, 'NOK'), 'receipt', 'snacks');
      sys.clock.advance(DAY);
    }
    const counts = new Map<string, number>();
    for (const r of await sys.refills.list()) counts.set(r.purchase!.volunteerId, (counts.get(r.purchase!.volunteerId) ?? 0) + 1);
    const values = [...counts.values()];
    expect(counts.size).toBe(20);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
  });
});
