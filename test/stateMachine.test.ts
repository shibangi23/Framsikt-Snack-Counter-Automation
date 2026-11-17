import { describe, expect, it } from 'vitest';
import { InMemoryRefillRepository } from '../src/adapters/InMemoryRepositories';
import { ConflictError, IllegalTransitionError } from '../src/domain/errors';
import { newRefill, transition } from '../src/domain/stateMachine';

const at = new Date('2026-03-02T08:00:00Z');

describe('refill state machine', () => {
  it('appends a history entry for every legal transition', () => {
    const refill = newRefill('r1', 'OSLO', 'emp-1', at);
    transition(refill, 'OFFERED', at, 'system', 'box reported empty');
    expect(refill.state).toBe('OFFERED');
    expect(refill.history).toEqual([{ from: 'REPORTED_EMPTY', to: 'OFFERED', at, actor: 'system', reason: 'box reported empty' }]);
  });

  it('throws on an illegal transition such as PURCHASED -> OFFERED', () => {
    const refill = newRefill('r1', 'OSLO', 'emp-1', at);
    refill.state = 'PURCHASED';
    expect(() => transition(refill, 'OFFERED', at, 'system', 'oops')).toThrow(IllegalTransitionError);
    expect(refill.state).toBe('PURCHASED');
    expect(refill.history).toHaveLength(0);
  });
});

describe('InMemoryRefillRepository.updateIfVersion', () => {
  it('throws ConflictError on a stale version and keeps the stored refill unchanged', async () => {
    const repo = new InMemoryRefillRepository();
    await repo.createIfNoActive(newRefill('r1', 'OSLO', 'emp-1', at));
    await repo.updateIfVersion('r1', 0, (r) => transition(r, 'OFFERED', at, 'system', 'x'));
    await expect(repo.updateIfVersion('r1', 0, (r) => (r.offeredTo = 'someone'))).rejects.toThrow(ConflictError);
    expect((await repo.get('r1')).offeredTo).toBeNull();
  });

  it('stores nothing when the mutation throws', async () => {
    const repo = new InMemoryRefillRepository();
    await repo.createIfNoActive(newRefill('r1', 'OSLO', 'emp-1', at));
    await expect(repo.updateIfVersion('r1', 0, (r) => transition(r, 'REIMBURSED', at, 'x', 'x'))).rejects.toThrow(
      IllegalTransitionError,
    );
    expect(await repo.get('r1')).toMatchObject({ state: 'REPORTED_EMPTY', version: 0 });
  });
});
