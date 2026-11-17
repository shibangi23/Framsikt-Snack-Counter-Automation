// One small base class so every error carries its own class name in logs and tests.
class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class IllegalTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super(`Illegal refill transition ${from} -> ${to}`);
  }
}

export class ConflictError extends DomainError {
  constructor(id: string, expected: number, actual: number) {
    super(`Refill ${id} was changed by someone else (expected version ${expected}, found ${actual})`);
  }
}

export class ClaimRejectedError extends DomainError {}

export class NotAllowedError extends DomainError {}

export class NotFoundError extends DomainError {}

export class BudgetExceededError extends DomainError {}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}
