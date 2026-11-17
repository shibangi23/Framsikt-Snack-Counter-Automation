# Snack Counter Automation
Core logic for keeping the Oslo and Bengaluru snack counters stocked by volunteers.
The system automates **coordination, not shopping**: it detects an empty box, offers the job to
one fairly chosen volunteer, tracks a deadline, files the HR reimbursement claim exactly once and
records the spend against each office's monthly budget.

## How to run

Requires Node 20+.

```bash
npm install
npm test            # Vitest, deterministic, no real waiting
npm run typecheck   # tsc --noEmit, strict mode
npm run simulate    # 90-day seeded simulation: fair picker vs naive baseline
```

## Architecture

The code uses ports and adapters. `src/domain` holds pure rules: integer `Money`, office config,
and the refill state machine, which is one table of legal transitions where every move is recorded
in `refill.history`. `src/ports` defines the outside world as interfaces (`Clock`, `ChatPort`,
`HrPort` and repositories). `src/adapters` implements those interfaces with in-memory fakes.
`src/services` holds the behaviour:
- `RefillService` runs the lifecycle (`reportEmpty`, `claim`, `decline`, `recordPurchase`, `handleHrStatus`, and `tick()` for all time-based work).
- `Picker` is a pure ranking function.
- `BudgetLedger` reserves and settles spend per office in its local month.
- `HrOutbox` sends each HR claim once, with retries.
- `ReportService` builds the monthly cross-office report.

Two writers can never both win. The repository's compare-and-set `updateIfVersion` ensures that,
and `createFakeSystem` in `src/createSystem.ts` wires everything together for tests and the
simulation.

See [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md) for the full explanation.
