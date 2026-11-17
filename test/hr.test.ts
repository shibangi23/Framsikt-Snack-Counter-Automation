import { describe, expect, it } from 'vitest';
import { CurrencyMismatchError, IllegalTransitionError } from '../src/domain/errors';
import { money } from '../src/domain/money';
import { DAY } from '../src/domain/time';
import { backoffMs } from '../src/services/HrOutbox';
import { setup, team } from './helpers';

/** Report, claim and buy one Oslo refill. */
async function purchasedRefill() {
  const sys = setup(team('OSLO', 3));
  const refill = await sys.service.reportEmpty('OSLO', 'emp');
  await sys.service.claim(refill.id, 'osl-01');
  await sys.service.recordPurchase(refill.id, 'osl-01', money(45_000, 'NOK'), 'receipt-1.jpg', 'Fruit and nuts', [
    { name: 'banana', quantity: 12 },
  ]);
  return { sys, refillId: refill.id };
}

describe('recordPurchase', () => {
  it('settles the ledger, moves to PURCHASED and enqueues one HR claim', async () => {
    const { sys, refillId } = await purchasedRefill();
    expect((await sys.refills.get(refillId)).state).toBe('PURCHASED');
    expect((await sys.ledgerEntries.list()).map((e) => [e.type, e.amount.amount])).toEqual([['SPENT', 45_000]]);
    expect(await sys.outbox.isSent(refillId)).toBe(false);
  });

  it('is only allowed from CLAIMED', async () => {
    const sys = setup(team('OSLO', 3));
    const refill = await sys.service.reportEmpty('OSLO', 'emp');
    await expect(sys.service.recordPurchase(refill.id, 'osl-01', money(1, 'NOK'), 'r', 'd')).rejects.toThrow(
      IllegalTransitionError,
    );
  });

  it('rejects a receipt in a currency other than the office currency', async () => {
    const sys = setup(team('OSLO', 3));
    const refill = await sys.service.reportEmpty('OSLO', 'emp');
    await sys.service.claim(refill.id, 'osl-01');
    await expect(sys.service.recordPurchase(refill.id, 'osl-01', money(100, 'INR'), 'r', 'd')).rejects.toThrow(
      CurrencyMismatchError,
    );
  });
});

describe('HrOutbox', () => {
  it('a failed send retries with backoff and creates exactly one HR claim', async () => {
    const { sys, refillId } = await purchasedRefill();
    sys.hr.failNextSubmits(1);

    await sys.service.tick(); // attempt 1 fails
    expect(sys.hr.submitCalls).toBe(1);
    expect(sys.hr.claims.size).toBe(0);
    expect(await sys.outboxItems.get(refillId)).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect((await sys.refills.get(refillId)).state).toBe('PURCHASED');

    await sys.service.tick(); // still inside the backoff window: no attempt
    expect(sys.hr.submitCalls).toBe(1);

    sys.clock.advance(backoffMs(1));
    await sys.service.tick(); // attempt 2 succeeds
    await sys.service.tick();
    expect(sys.hr.submitCalls).toBe(2);
    expect(sys.hr.claims.size).toBe(1);
    expect(sys.hr.duplicateAttempts).toBe(0);
    expect((await sys.refills.get(refillId)).state).toBe('SUBMITTED_TO_HR');
  });

  it('flushing twice (even at the same time) creates one claim and never sends a duplicate', async () => {
    const { sys } = await purchasedRefill();
    await Promise.all([sys.outbox.flush(), sys.outbox.flush()]);
    await sys.outbox.flush();
    expect(sys.hr.claims.size).toBe(1);
    expect(sys.hr.submitCalls).toBe(1);
    expect(sys.hr.duplicateAttempts).toBe(0);
  });

  it('if HR already has the claim (our earlier reply was lost), the item counts as sent', async () => {
    const { sys, refillId } = await purchasedRefill();
    const item = (await sys.outboxItems.get(refillId))!;
    sys.hr.claims.set(refillId, item.claim); // HR stored it, but we never heard back
    await sys.service.tick();
    await sys.service.tick();
    expect(sys.hr.claims.size).toBe(1);
    expect((await sys.refills.get(refillId)).state).toBe('SUBMITTED_TO_HR');
  });

  it('uses exponential backoff', () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
  });
});

describe('HR status', () => {
  async function submitted() {
    const ctx = await purchasedRefill();
    await ctx.sys.service.tick();
    return ctx;
  }

  it('approval leads to REIMBURSED', async () => {
    const { sys, refillId } = await submitted();
    await sys.hr.approve(refillId);
    expect((await sys.refills.get(refillId)).state).toBe('REIMBURSED');
    await sys.hr.approve(refillId); // a repeated webhook is harmless
  });

  it('rejection leads to REJECTED_BY_HR, notifies a manager and keeps the spend', async () => {
    const { sys, refillId } = await submitted();
    await sys.hr.reject(refillId);
    expect((await sys.refills.get(refillId)).state).toBe('REJECTED_BY_HR');
    expect(sys.chat.textsTo('manager', 'OSLO')).toHaveLength(1);
    expect((await sys.ledgerEntries.list()).filter((e) => e.type === 'SPENT')).toHaveLength(1);
  });

  it('nudges a manager once when a claim has waited 10 days at HR', async () => {
    const { sys } = await submitted();
    sys.clock.advance(10 * DAY - 1);
    await sys.service.tick();
    expect(sys.chat.textsTo('manager', 'OSLO')).toHaveLength(0);
    sys.clock.advance(1);
    await sys.service.tick();
    await sys.service.tick();
    expect(sys.chat.textsTo('manager', 'OSLO')).toHaveLength(1);
  });
});
