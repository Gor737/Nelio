// M8: the real MailService and the real SMTP transport against Mailpit (docker-compose: SMTP 1025, inbox API on 8025).
// It proves the development setup works end to end. It deletes only its own messages (never the developer's inbox), and it
// SKIPS ITSELF when Mailpit is not running (for example in CI, which has no Mailpit service).
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import {
  MailModule,
  MailService,
} from '../../src/infrastructure/mail/index.js';
import { testEnv } from '../support/integration-app.js';

const INBOX = 'http://127.0.0.1:8025/api/v1';

let probeError = '';
async function mailpitIsRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${INBOX}/info`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch (error) {
    probeError = String((error as Error)?.message ?? error);
    return false;
  }
}

interface MailpitSummary {
  ID: string;
  Subject: string;
  From: { Address: string; Name: string };
  To: { Address: string }[];
}
interface MailpitMessage {
  Text: string;
  HTML: string;
}

const available = await mailpitIsRunning();
const suite = available ? describe : describe.skip;
if (!available)
  console.warn(
    'mail-smtp.integration-spec: Mailpit is not running on 127.0.0.1:8025, the SMTP smoke test is skipped (' +
      probeError +
      ')',
  );

suite('MailService over real SMTP (Mailpit)', () => {
  let mail: MailService;
  let close: () => Promise<void>;
  const recipient = `smoke-${randomUUID()}@nelio-smoke.test`;
  const ids: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(
          testEnv({ FRONTEND_ORIGIN: 'http://localhost:3001' }),
        ),
        MailModule,
      ],
    }).compile();
    await moduleRef.init();
    mail = moduleRef.get(MailService);
    close = () => moduleRef.close();
  });

  afterAll(async () => {
    if (ids.length > 0)
      await fetch(`${INBOX}/messages`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ IDs: ids }),
      });
    await close();
  });

  const waitForMessages = async (count: number): Promise<MailpitSummary[]> => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const res = await fetch(
        `${INBOX}/search?query=${encodeURIComponent(`to:${recipient}`)}`,
      );
      const body = (await res.json()) as { messages: MailpitSummary[] };
      if (body.messages.length >= count || Date.now() > deadline) {
        ids.push(
          ...body.messages.map((m) => m.ID).filter((id) => !ids.includes(id)),
        );
        return body.messages;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const fullMessage = async (id: string) =>
    (await (await fetch(`${INBOX}/message/${id}`)).json()) as MailpitMessage;

  it('delivers the three emails to the inbox with the right sender, subject and links', async () => {
    expect(
      await mail.sendEmailVerification(recipient, {
        fullName: 'Smoke Test',
        token: 'verify-token-123',
        validForHours: 24,
      }),
    ).toBe(true);
    expect(
      await mail.sendPasswordReset(recipient, {
        fullName: 'Smoke Test',
        token: 'reset-token-456',
        validForHours: 1,
      }),
    ).toBe(true);
    expect(
      await mail.sendAlreadyRegistered(recipient, { fullName: 'Smoke Test' }),
    ).toBe(true);

    const messages = await waitForMessages(3);
    expect(messages).toHaveLength(3);
    const bySubject = Object.fromEntries(messages.map((m) => [m.Subject, m]));
    expect(Object.keys(bySubject).sort()).toEqual([
      'Confirm your email address for Nelio',
      'Reset your Nelio password',
      'You already have a Nelio account',
    ]);
    for (const message of messages) {
      expect(message.From).toMatchObject({
        Address: 'no-reply@nelio.local',
        Name: 'Nelio',
      });
      expect(message.To.map((t) => t.Address)).toEqual([recipient]);
    }

    const verify = await fullMessage(
      bySubject['Confirm your email address for Nelio'].ID,
    );
    expect(verify.Text).toContain(
      'http://localhost:3001/verify-email?token=verify-token-123',
    );
    expect(verify.HTML).toContain('verify-email?token=verify-token-123');
    const reset = await fullMessage(bySubject['Reset your Nelio password'].ID);
    expect(reset.Text).toContain(
      'http://localhost:3001/reset-password?token=reset-token-456',
    );
    const already = await fullMessage(
      bySubject['You already have a Nelio account'].ID,
    );
    expect(already.Text).toContain('http://localhost:3001/login');
    expect(already.Text).toContain('http://localhost:3001/forgot-password');
    expect(already.Text).not.toContain('token=');
  });
});
