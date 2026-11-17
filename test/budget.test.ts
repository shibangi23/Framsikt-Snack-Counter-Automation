import { describe, expect, it } from 'vitest';
import { BudgetExceededError } from '../src/domain/errors';
import { add, money, RateSnapshot, zero } from '../src/domain/money';
import { monthKey } from '../src/domain/time';
import { setup, START, team } from './helpers';

const MARCH = '2026-03';
const rate: RateSnapshot = { base: 'NOK', nokPerInr: 0.125, asOf: '2026-03-31' };

function bothOffices() {
  return setup([...team('OSLO', 2), ...team('BENGALURU', 2)]);
}

describe('BudgetLedger', () => {
  it('reserve then settle leaves only SPENT', async () => {
    const sys = bothOffices();
    const refill = await sys.service.reportEmpty('OSLO', 'emp');
    await sys.service.claim(refill.id, refill.offeredTo!);
    expect(await sys.ledger.totals('OSLO', MARCH)).toEqual({ spent: zero('NOK'), reserved: money(120_000, 'NOK') });

    const result = await sys.ledger.settle(refill.id, 'OSLO', money(50_000, 'NOK'));
    expect(result.overReservation).toBe(false);
    expect(await sys.ledger.totals('OSLO', MARCH)).toEqual({ spent: money(50_000, 'NOK'), reserved: zero('NOK') });
  });

  it('keeps Oslo and Bengaluru totals separate in native currency', async () => {
    const sys = bothOffices();
    for (const office of ['OSLO', 'BENGALURU'] as const) {
      const refill = await sys.service.reportEmpty(office, 'emp');
      await sys.service.claim(refill.id, refill.offeredTo!);
    }
    expect((await sys.ledger.totals('OSLO', MARCH)).reserved).toEqual(money(120_000, 'NOK'));
    expect((await sys.ledger.totals('BENGALURU', MARCH)).reserved).toEqual(money(300_000, 'INR'));
  });

  it('flags a settle above the reservation but still records it', async () => {
    const sys = bothOffices();
    const refill = await sys.service.reportEmpty('OSLO', 'emp');
    await sys.service.claim(refill.id, refill.offeredTo!);
    const result = await sys.ledger.settle(refill.id, 'OSLO', money(150_000, 'NOK'));
    expect(result.overReservation).toBe(true);
    expect((await sys.ledger.totals('OSLO', MARCH)).spent).toEqual(money(150_000, 'NOK'));
  });

  it('blocks a claim at 100% of budget without an override, allows it with one', async () => {
    const sys = bothOffices();
    await sys.ledgerEntries.add({ office: 'OSLO', monthKey: MARCH, amount: money(600_000, 'NOK'), type: 'SPENT', refillId: 'old' });
    const refill = await sys.service.reportEmpty('OSLO', 'emp');

    await expect(sys.service.claim(refill.id, refill.offeredTo!)).rejects.toThrow(BudgetExceededError);
    expect((await sys.refills.get(refill.id)).state).toBe('OFFERED');
    expect(sys.chat.textsTo('manager', 'OSLO')).toHaveLength(1);

    await sys.ledger.approveOverride(refill.id);
    const { refill: claimed } = await sys.service.claim(refill.id, refill.offeredTo!);
    expect(claimed.state).toBe('CLAIMED');
  });

  it('returns a warning flag at 80% of budget', async () => {
    const at79 = bothOffices();
    await at79.ledgerEntries.add({ office: 'OSLO', monthKey: MARCH, amount: money(350_000, 'NOK'), type: 'SPENT', refillId: 'old' });
    const r1 = await at79.service.reportEmpty('OSLO', 'emp');
    expect((await at79.service.claim(r1.id, r1.offeredTo!)).budgetWarning).toBe(false); // 4,700 of 6,000

    const at80 = bothOffices();
    await at80.ledgerEntries.add({ office: 'OSLO', monthKey: MARCH, amount: money(360_000, 'NOK'), type: 'SPENT', refillId: 'old' });
    const r2 = await at80.service.reportEmpty('OSLO', 'emp');
    expect((await at80.service.claim(r2.id, r2.offeredTo!)).budgetWarning).toBe(true); // 4,800 of 6,000
  });
});

describe('month in the office timezone', () => {
  it('puts a purchase at 23:30 UTC on the last day of January in each office local month', () => {
    const lateUtc = new Date('2026-01-31T23:30:00Z');
    expect(monthKey(lateUtc, 'UTC')).toBe('2026-01');
    expect(monthKey(lateUtc, 'Europe/Oslo')).toBe('2026-02'); // 00:30 on 1 Feb
    expect(monthKey(lateUtc, 'Asia/Kolkata')).toBe('2026-02'); // 05:00 on 1 Feb
    // At 22:00 UTC the two offices disagree: still January in Oslo, already February in Bengaluru.
    const earlier = new Date('2026-01-31T22:00:00Z');
    expect(monthKey(earlier, 'Europe/Oslo')).toBe('2026-01');
    expect(monthKey(earlier, 'Asia/Kolkata')).toBe('2026-02');
  });

  it('the ledger files SPENT in the office local month', async () => {
    const sys = setup([...team('OSLO', 1), ...team('BENGALURU', 1)], {}, new Date('2026-01-31T12:00:00Z'));
    const oslo = await sys.service.reportEmpty('OSLO', 'emp');
    const blr = await sys.service.reportEmpty('BENGALURU', 'emp');
    await sys.service.claim(oslo.id, oslo.offeredTo!);
    await sys.service.claim(blr.id, blr.offeredTo!);
    sys.clock.set(new Date('2026-01-31T23:30:00Z'));
    await sys.ledger.settle(oslo.id, 'OSLO', money(50_000, 'NOK'));
    await sys.ledger.settle(blr.id, 'BENGALURU', money(100_000, 'INR'));
    const spent = (await sys.ledgerEntries.list()).filter((e) => e.type === 'SPENT');
    expect(spent.map((e) => [e.office, e.monthKey])).toEqual([
      ['OSLO', '2026-02'],
      ['BENGALURU', '2026-02'],
    ]);
  });
});

describe('ReportService', () => {
  it('combines both offices in NOK with the given rate and states the rate', async () => {
    const sys = bothOffices();
    await sys.ledgerEntries.add({ office: 'OSLO', monthKey: MARCH, amount: money(100_000, 'NOK'), type: 'SPENT', refillId: 'a' });
    await sys.ledgerEntries.add({ office: 'BENGALURU', monthKey: MARCH, amount: money(800_000, 'INR'), type: 'SPENT', refillId: 'b' });
    const report = await sys.reports.monthly(MARCH, rate);
    expect(report.combinedSpentNok).toEqual(money(200_000, 'NOK')); // 1,000 NOK + 8,000 INR x 0.125
    expect(report.rate).toEqual(rate);
    expect(report.offices.map((o) => [o.office, o.spent])).toEqual([
      ['OSLO', money(100_000, 'NOK')],
      ['BENGALURU', money(800_000, 'INR')],
    ]);
  });

  it('lists the top items by quantity when items were recorded', async () => {
    const sys = bothOffices();
    const items = [
      [{ name: 'banana', quantity: 12 }, { name: 'nuts', quantity: 3 }],
      [{ name: 'chai biscuits', quantity: 20 }, { name: 'banana', quantity: 6 }],
    ];
    for (const [i, office] of (['OSLO', 'BENGALURU'] as const).entries()) {
      const refill = await sys.service.reportEmpty(office, 'emp');
      const amount = office === 'OSLO' ? money(40_000, 'NOK') : money(150_000, 'INR');
      await sys.service.claim(refill.id, refill.offeredTo!);
      await sys.service.recordPurchase(refill.id, refill.offeredTo!, amount, 'r', 'snacks', items[i]);
    }
    const report = await sys.reports.monthly(MARCH, rate);
    expect(report.topItems).toEqual([
      { name: 'chai biscuits', quantity: 20 },
      { name: 'banana', quantity: 18 },
      { name: 'nuts', quantity: 3 },
    ]);
  });

  it('report totals equal the sum of ledger entries', async () => {
    const sys = bothOffices();
    const oslo = await sys.service.reportEmpty('OSLO', 'emp');
    await sys.service.claim(oslo.id, oslo.offeredTo!);
    await sys.ledger.settle(oslo.id, 'OSLO', money(73_450, 'NOK'));
    await sys.ledgerEntries.add({ office: 'BENGALURU', monthKey: MARCH, amount: money(212_345, 'INR'), type: 'SPENT', refillId: 'old' });
    const open = await sys.service.reportEmpty('BENGALURU', 'emp'); // leaves a reservation
    await sys.service.claim(open.id, open.offeredTo!);

    const report = await sys.reports.monthly(MARCH, rate);
    const entries = await sys.ledgerEntries.list();
    for (const o of report.offices) {
      const mine = entries.filter((e) => e.office === o.office && e.monthKey === MARCH);
      const total = (type: string) => mine.filter((e) => e.type === type).reduce((acc, e) => add(acc, e.amount), zero(o.spent.currency));
      expect(o.spent).toEqual(total('SPENT'));
      expect(o.reserved).toEqual(total('RESERVED'));
    }
    expect(monthKey(START, 'Europe/Oslo')).toBe(MARCH);
  });
});
