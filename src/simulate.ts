/**
 * 90 simulated days, 15 Oslo and 20 Bengaluru volunteers. Run twice with the same seed:
 *   A) our Picker            B) a naive baseline where the same 3 people always answer first
 * Usage: npm run simulate
 */
import { createFakeSystem } from './createSystem';
import { BudgetExceededError } from './domain/errors';
import { format, money, RateSnapshot } from './domain/money';
import { OfficeId, OFFICES } from './domain/offices';
import { DAY, HOUR } from './domain/time';
import { Volunteer } from './domain/types';
import { RankFn } from './services/Picker';

const SEED = 42;
const DAYS = 90;
const START = new Date('2026-01-01T00:00:00Z');
const MONTHS = ['2026-01', '2026-02', '2026-03'];
const RATE: RateSnapshot = { base: 'NOK', nokPerInr: 0.12, asOf: '2026-03-31' };
const TEAM_SIZE: Record<OfficeId, number> = { OSLO: 15, BENGALURU: 20 };
/** Typical purchase range in whole currency units. */
const PURCHASE_RANGE: Record<OfficeId, [number, number]> = { OSLO: [300, 1_200], BENGALURU: [500, 3_000] };
/** Chance per day that someone reports the box empty (about 80% of budget on average). */
const EMPTY_CHANCE = 0.21;

/** Small, well-known seeded PRNG: same seed, same numbers, every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeTeam(office: OfficeId): Volunteer[] {
  const prefix = office === 'OSLO' ? 'osl' : 'blr';
  return Array.from({ length: TEAM_SIZE[office] }, (_, i) => ({
    id: `${prefix}-${String(i + 1).padStart(2, '0')}`,
    homeOffice: office,
    currentOffice: office,
    presence: 'IN_OFFICE' as const,
    expiryCount: 0,
  }));
}

/** Today's world: the first 3 people of each office always see and grab the job first. */
const naiveBaseline: RankFn = ({ refill, volunteers }) => {
  const eager = (v: Volunteer) => (Number(v.id.slice(4)) <= 3 ? 0 : 1);
  return volunteers
    .filter((v) => v.currentOffice === refill.office && v.presence !== 'ON_LEAVE' && !refill.excluded.includes(v.id))
    .sort((a, b) => eager(a) - eager(b) || a.id.localeCompare(b.id));
};

async function run(label: string, rank?: RankFn): Promise<void> {
  // Two streams so the world (leave, visits, empty boxes) is drawn the same way in both runs.
  const world = mulberry32(SEED);
  const act = mulberry32(SEED + 1);
  const between = (rnd: () => number, lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

  const sys = createFakeSystem({ start: START, volunteers: [...makeTeam('OSLO'), ...makeTeam('BENGALURU')], rank });
  const away = new Map<string, { leaveUntil: number; visitUntil: number }>();
  const answered = new Set<string>();
  const buyAt = new Map<string, number>(); // refillId -> hour the volunteer will buy
  const hrDecisionAt = new Map<string, number>(); // refillId -> hour HR approves
  const peakOwed = { NOK: 0, INR: 0 };
  let overrides = 0;

  for (let hour = 0; hour < DAYS * 24; hour++) {
    const day = Math.floor(hour / 24);

    if (hour % 24 === 5) {
      // Morning: decide who is on leave, remote, in office or visiting the other office.
      for (const v of await sys.volunteers.list()) {
        const plan = away.get(v.id) ?? { leaveUntil: -1, visitUntil: -1 };
        if (day >= plan.leaveUntil && world() < 0.01) plan.leaveUntil = day + between(world, 3, 10);
        if (day >= plan.visitUntil && world() < 0.004) plan.visitUntil = day + between(world, 7, 14);
        away.set(v.id, plan);
        const other: OfficeId = v.homeOffice === 'OSLO' ? 'BENGALURU' : 'OSLO';
        const remote = world() < 0.4;
        await sys.volunteers.save({
          ...v,
          currentOffice: day < plan.visitUntil ? other : v.homeOffice,
          presence: day < plan.leaveUntil ? 'ON_LEAVE' : remote ? 'REMOTE' : 'IN_OFFICE',
        });
      }
    }

    if (hour % 24 === 9) {
      for (const office of ['OSLO', 'BENGALURU'] as const) {
        if (world() < EMPTY_CHANCE) await sys.service.reportEmpty(office, 'employee');
      }
    }

    for (const refill of await sys.refills.list()) {
      if (refill.state === 'OFFERED' && refill.offeredTo && !answered.has(`${refill.id}:${refill.offeredTo}`)) {
        const volunteerId = refill.offeredTo;
        answered.add(`${refill.id}:${volunteerId}`);
        const v = await sys.volunteers.get(volunteerId);
        const accept = v.presence === 'IN_OFFICE' ? 0.75 : 0.35;
        const roll = act();
        if (roll < accept) {
          try {
            await sys.service.claim(refill.id, volunteerId);
          } catch (error) {
            if (!(error instanceof BudgetExceededError)) throw error;
            overrides++; // the simulated manager approves every request
            await sys.ledger.approveOverride(refill.id);
            await sys.service.claim(refill.id, volunteerId);
          }
          if (act() < 0.9) buyAt.set(refill.id, hour + between(act, 2, 20)); // 10% forget: the claim expires
        } else if (roll < accept + 0.15) {
          await sys.service.decline(refill.id, volunteerId);
        } // otherwise: no answer, the offer times out
      }

      if (refill.state === 'CLAIMED' && (buyAt.get(refill.id) ?? Infinity) <= hour) {
        buyAt.delete(refill.id);
        const [lo, hi] = PURCHASE_RANGE[refill.office];
        const amount = money(between(act, lo, hi) * 100, OFFICES[refill.office].currency);
        await sys.service.recordPurchase(refill.id, refill.claimedBy!, amount, `receipt-${refill.id}`, 'Snacks');
      }

      if (refill.state === 'SUBMITTED_TO_HR') {
        if (!hrDecisionAt.has(refill.id)) hrDecisionAt.set(refill.id, hour + between(act, 1, 10) * 24);
        if (hrDecisionAt.get(refill.id)! <= hour) await sys.hr.approve(refill.id);
      }
    }

    await sys.service.tick();

    // Track the most money any one person has waiting for reimbursement at once.
    const owed = new Map<string, number>();
    for (const r of await sys.refills.list()) {
      if (r.purchase && (r.state === 'PURCHASED' || r.state === 'SUBMITTED_TO_HR')) {
        const key = `${r.purchase.volunteerId}:${r.purchase.amount.currency}`;
        owed.set(key, (owed.get(key) ?? 0) + r.purchase.amount.amount);
      }
    }
    for (const [key, amount] of owed) {
      const currency = key.endsWith('NOK') ? 'NOK' : 'INR';
      peakOwed[currency] = Math.max(peakOwed[currency], amount);
    }

    sys.clock.advance(HOUR);
  }

  // ---- Print a short summary ----
  const refills = await sys.refills.list();
  const volunteers = await sys.volunteers.list();
  console.log(`\n=== ${label} ===`);
  for (const office of ['OSLO', 'BENGALURU'] as const) {
    const counts = volunteers
      .filter((v) => v.homeOffice === office)
      .map((v) => refills.filter((r) => r.purchase?.volunteerId === v.id).length)
      .sort((a, b) => b - a);
    console.log(`${office.padEnd(10)} refills per volunteer: ${counts.join(' ')}  (max ${counts[0]}, min ${counts.at(-1)})`);
  }

  const waits = refills
    .filter((r) => r.state === 'REIMBURSED')
    .map((r) => r.history.find((h) => h.to === 'REIMBURSED')!.at.getTime() - r.purchase!.at.getTime());
  const expiries = volunteers.reduce((n, v) => n + v.expiryCount, 0);
  console.log(
    `Longest wait for reimbursement: ${(Math.max(...waits) / DAY).toFixed(1)} days | ` +
      `most owed to one person at once: ${format(money(peakOwed.NOK, 'NOK'))}, ${format(money(peakOwed.INR, 'INR'))}`,
  );
  console.log(`Expired claims: ${expiries} | budget overrides: ${overrides}`);

  for (const month of MONTHS) {
    const report = await sys.reports.monthly(month, RATE);
    const cells = report.offices.map((o) => `${o.office} ${format(o.spent)} / ${format(o.budget)}`);
    console.log(`${month}  ${cells.join('  |  ')}  |  combined ${format(report.combinedSpentNok)}`);
  }
}

await run('A) Fair picker');
await run('B) Naive baseline: the same 3 volunteers always respond first', naiveBaseline);
console.log(`\nRate used for the combined total: ${RATE.nokPerInr} NOK per INR as of ${RATE.asOf}.`);
