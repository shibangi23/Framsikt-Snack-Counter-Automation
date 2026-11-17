import { FakeChat } from './adapters/FakeChat';
import { FakeClock } from './adapters/FakeClock';
import { FakeHr } from './adapters/FakeHr';
import {
  InMemoryLedgerRepository,
  InMemoryOutboxRepository,
  InMemoryRefillRepository,
  InMemoryVolunteerRepository,
} from './adapters/InMemoryRepositories';
import { Volunteer } from './domain/types';
import { BudgetLedger } from './services/BudgetLedger';
import { HrOutbox } from './services/HrOutbox';
import { RankFn } from './services/Picker';
import { RefillConfig, RefillService } from './services/RefillService';
import { ReportService } from './services/ReportService';

export interface SystemOptions {
  start: Date;
  volunteers?: Volunteer[];
  config?: Partial<RefillConfig>;
  rank?: RankFn;
}

/** Wires every service to fakes and in-memory repositories. Used by tests and the simulation. */
export function createFakeSystem(options: SystemOptions) {
  const clock = new FakeClock(options.start);
  const chat = new FakeChat();
  const hr = new FakeHr();
  const refills = new InMemoryRefillRepository();
  const volunteers = new InMemoryVolunteerRepository(options.volunteers ?? []);
  const ledgerEntries = new InMemoryLedgerRepository();
  const ledger = new BudgetLedger(ledgerEntries, refills, clock);
  const outboxItems = new InMemoryOutboxRepository();
  const outbox = new HrOutbox(outboxItems, hr, clock);
  const service = new RefillService({
    refills,
    volunteers,
    ledger,
    outbox,
    chat,
    clock,
    config: options.config,
    rank: options.rank,
  });
  const reports = new ReportService(ledger, refills);
  hr.onStatus = (refillId, status) => service.handleHrStatus(refillId, status);
  return { clock, chat, hr, refills, volunteers, ledgerEntries, ledger, outboxItems, outbox, service, reports };
}
