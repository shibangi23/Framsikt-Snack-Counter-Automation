import { ChatPort, ChatTarget } from '../ports/ChatPort';

export interface SentMessage {
  to: ChatTarget;
  text: string;
}

/** Records every outbound message so tests can assert on them. */
export class FakeChat implements ChatPort {
  readonly sent: SentMessage[] = [];

  async send(to: ChatTarget, text: string): Promise<void> {
    this.sent.push({ to, text });
  }

  textsTo(kind: ChatTarget['kind'], who: string): string[] {
    return this.sent
      .filter((m) => m.to.kind === kind && (m.to.kind === 'volunteer' ? m.to.volunteerId : m.to.office) === who)
      .map((m) => m.text);
  }
}
