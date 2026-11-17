import { CurrencyMismatchError } from './errors';

export type Currency = 'NOK' | 'INR';

// WHY integer minor units (øre, paise): floats cannot store 0.10 exactly,
// and reimbursements and budgets must add up to the exact øre.
export interface Money {
  readonly amount: number;
  readonly currency: Currency;
}

export function money(amount: number, currency: Currency): Money {
  if (!Number.isInteger(amount)) {
    throw new Error(`Money must be an integer number of minor units, got ${amount}`);
  }
  return { amount, currency };
}

export function zero(currency: Currency): Money {
  return money(0, currency);
}

// WHY throw: adding NOK to INR silently would put a meaningless number in a report.
function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

/** Returns -1, 0 or 1. */
export function compare(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return Math.sign(a.amount - b.amount);
}

export function sum(values: Money[], currency: Currency): Money {
  return values.reduce(add, zero(currency));
}

export interface RateSnapshot {
  base: 'NOK';
  nokPerInr: number;
  asOf: string;
}

// WHY rounding only here: conversion is the one place a fraction of an øre can appear.
// Math.round on integer inputs gives the same answer every time.
export function toNok(value: Money, rate: RateSnapshot): Money {
  if (value.currency === 'NOK') return value;
  return money(Math.round(value.amount * rate.nokPerInr), 'NOK');
}

/** Display only, e.g. "1,200.00 NOK". */
export function format(value: Money): string {
  const whole = Math.floor(value.amount / 100).toLocaleString('en-US');
  const minor = String(value.amount % 100).padStart(2, '0');
  return `${whole}.${minor} ${value.currency}`;
}
