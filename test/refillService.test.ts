import { describe, expect, it } from 'vitest';
import { ClaimRejectedError } from '../src/domain/errors';
import { rankCandidates } from '../src/services/Picker';
import { DEFAULT_CONFIG } from '../src/services/RefillService';
import { HOUR, MINUTE } from '../src/domain/time';
import { setup, team, volunteer } from './helpers';

describe('reportEmpty', () => {
  it('offers a new refill to exactly one volunteer', async () => {
    const sys = setup(team('OSLO', 3));
    const refill = await sys.service.reportEmpty('OSLO', 'emp-9');
    expect(refill.state).toBe('OFFERED');
    expect(refill.offeredTo).toBe('osl-01');
    expect(sys.chat.textsTo('volunteer', 'osl-01')).toHaveLength(1);
  });

  it('a second report while a refill is active creates no new refill', async () => {
    const sys = setup(team('OSLO', 3));
    const first = await sys.service.reportEmpty('OSLO', 'emp-1');
    const second = await sys.service.reportEmpty('OSLO', 'emp-2');
    expect(second.id).toBe(first.id);
    expect(await sys.refills.list()).toHaveLength(1);
  });

  it('two concurrent reports create one refill', async () => {
    const sys = setup(team('OSLO', 3));
    const [a, b] = await Promise.all([sys.service.reportEmpty('OSLO', 'emp-1'), sys.service.reportEmpty('OSLO', 'emp-2')]);
    expect(a.id).toBe(b.id);
    expect(await sys.refills.list()).toHaveLength(1);
  });

  it('when nobody is eligible the refill stays OFFERED to nobody and the channel is told', async () => {
    const sys = setup([volunteer('osl-01', 'OSLO', { presence: 'ON_LEAVE' })]);
    const refill = await sys.service.reportEmpty('OSLO', 'emp-1');
    expect(refill).toMatchObject({ state: 'OFFERED', offeredTo: null });
    expect(sys.chat.textsTo('channel', 'OSLO')).toHaveLength(1);

    await sys.service.tick(); // still nobody: no second channel message
    expect(sys.chat.textsTo('channel', 'OSLO')).toHaveLength(1);

    await sys.volunteers.save(volunteer('osl-01', 'OSLO')); // back from leave
    await sys.service.tick();
    expect((await sys.refills.get(refill.id)).offeredTo).toBe('osl-01');
  });
});

describe('claim', () => {
  it('of several concurrent claims exactly one wins', async () => {
    const sys = setup(team('OSLO', 3));
    const refill = await sys.service.reportEmpty('OSLO', 'emp-1');
    const results = await Promise.allSettled([
      sys.service.claim(refill.id, 'osl-01'),
      sys.service.claim(refill.id, 'osl-01'),
      sys.service.claim(refill.id, 'osl-01'),
      sys.service.claim(refill.id, 'osl-02'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const reasons = results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason);
    for (const reason of reasons) expect(reason).toBeInstanceOf(ClaimRejectedError);
    // The duplicate osl-01 claims really raced: they lost on the version check, not on a pre-check.
    expect(reasons.filter((e) => e.message.startsWith('Someone else'))).toHaveLength(2);
    const stored = await sys.refills.get(refill.id);
    expect(stored.state).toBe('CLAIMED');
    expect(stored.history.filter((h) => h.to === 'CLAIMED')).toHaveLength(1);
  });

  it('a stale offeree whose offer was passed on cannot claim', async () => {
    const sys = setup(team('OSLO', 3));
    const refill = await sys.service.reportEmpty('OSLO', 'emp-1');
    sys.clock.advance(DEFAULT_CONFIG.offerWindowMs);
    await sys.service.tick();
    expect((await sys.refills.get(refill.id)).offeredTo).toBe('osl-02');
    await expect(sys.service.claim(refill.id, 'osl-01')).rejects.toThrow(ClaimRejectedError);
  });

  it('declining passes the offer to the next ranked volunteer', async () => {
    const sys = setup(team('OSLO', 3));
    const refill = await sys.service.reportEmpty('OSLO', 'emp-1');
    const after = await sys.service.decline(refill.id, 'osl-01');
    expect(after.offeredTo).toBe('osl-02');
    expect(after.excluded).toEqual(['osl-01']);
  });
});

describe('claim lease', () => {
  it('sends exactly one reminder at 50% of the claim window', async () => {
    const sys = setup(team('OSLO', 3));
    const refill = await sys.service.reportEmpty('OSLO', 'emp-1');
    await sys.service.claim(refill.id, 'osl-01');
    const reminders = () => sys.chat.textsTo('volunteer', 'osl-01').filter((t) => t.startsWith('Reminder'));

    sys.clock.advance(12 * HOUR - MINUTE);
    await sys.service.tick();
    expect(reminders()).toHaveLength(0);

    sys.clock.advance(MINUTE);
    await sys.service.tick();
    await sys.service.tick();
    sys.clock.advance(HOUR);
    await sys.service.tick();
    expect(reminders()).toHaveLength(1);
  });

  it('an uncompleted claim expires, is re-offered to a different volunteer, and the first ranks lower', async () => {
    const sys = setup(team('OSLO', 3));
    const refill = await sys.service.reportEmpty('OSLO', 'emp-1');
    await sys.service.claim(refill.id, 'osl-01');
    const reservations = async () => (await sys.ledgerEntries.list()).filter((e) => e.type === 'RESERVED');
    expect(await reservations()).toHaveLength(1);

    sys.clock.advance(DEFAULT_CONFIG.claimWindowMs);
    await sys.service.tick();
    expect(await reservations()).toHaveLength(0);

    const after = await sys.refills.get(refill.id);
    expect(after.state).toBe('OFFERED');
    expect(after.offeredTo).toBe('osl-02');
    expect(after.claimedBy).toBeNull();
    expect(after.history.map((h) => h.to)).toEqual(['OFFERED', 'CLAIMED', 'EXPIRED', 'OFFERED']);
    expect((await sys.volunteers.get('osl-01')).expiryCount).toBe(1);

    const ranked = rankCandidates({
      refill: { office: 'OSLO', excluded: [] },
      volunteers: await sys.volunteers.list(),
      refills: await sys.refills.list(),
      now: sys.clock.now(),
      unreimbursedLimit: DEFAULT_CONFIG.unreimbursedLimit,
    });
    expect(ranked.map((v) => v.id)).toEqual(['osl-02', 'osl-03', 'osl-01']);
  });
});
