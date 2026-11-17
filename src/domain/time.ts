export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function addMs(at: Date, ms: number): Date {
  return new Date(at.getTime() + ms);
}

// WHY the office timezone: a purchase at 00:30 on 1 February in Oslo is
// February spend, even though it is still 31 January in UTC.
export function monthKey(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(at);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  return `${year}-${month}`;
}
