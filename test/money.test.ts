import { describe, expect, it } from 'vitest';
import { CurrencyMismatchError } from '../src/domain/errors';
import { add, compare, money, RateSnapshot, toNok } from '../src/domain/money';

const rate: RateSnapshot = { base: 'NOK', nokPerInr: 0.125, asOf: '2026-03-31' };

describe('Money', () => {
  it('adds amounts in the same currency', () => {
    expect(add(money(150, 'NOK'), money(250, 'NOK'))).toEqual(money(400, 'NOK'));
  });

  it('throws when adding or comparing NOK and INR', () => {
    expect(() => add(money(100, 'NOK'), money(100, 'INR'))).toThrow(CurrencyMismatchError);
    expect(() => compare(money(100, 'NOK'), money(100, 'INR'))).toThrow(CurrencyMismatchError);
  });

  it('rejects fractional minor units', () => {
    expect(() => money(10.5, 'NOK')).toThrow();
  });

  it('rounds currency conversion deterministically with Math.round', () => {
    expect(toNok(money(3, 'INR'), rate)).toEqual(money(0, 'NOK')); // 0.375 -> 0
    expect(toNok(money(4, 'INR'), rate)).toEqual(money(1, 'NOK')); // 0.5   -> 1
    expect(toNok(money(12, 'INR'), rate)).toEqual(money(2, 'NOK')); // 1.5  -> 2
    expect(toNok(money(4, 'INR'), rate)).toEqual(toNok(money(4, 'INR'), rate));
    expect(toNok(money(500, 'NOK'), rate)).toEqual(money(500, 'NOK'));
  });
});
