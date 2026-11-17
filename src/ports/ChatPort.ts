import { OfficeId } from '../domain/offices';

export type ChatTarget =
  | { kind: 'volunteer'; volunteerId: string }
  | { kind: 'channel'; office: OfficeId }
  | { kind: 'manager'; office: OfficeId };

export interface ChatPort {
  send(to: ChatTarget, text: string): Promise<void>;
}
