// WHY a port: all time comes from here, so tests can jump 24 hours without waiting.
export interface Clock {
  now(): Date;
}
