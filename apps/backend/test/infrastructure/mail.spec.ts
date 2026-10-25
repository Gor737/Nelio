// Unit tests for the mail templates and MailService (M8): content, escaping, header-injection guard, "never throws", and that the
// log never contains the address, the link or the token.
import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { Transporter } from 'nodemailer';
import type { AppConfig } from '../../src/infrastructure/config/index.js';
import {
  MAIL_SEND_DEADLINE_MS,
  MailService,
} from '../../src/infrastructure/mail/mail.service.js';
import {
  alreadyRegistered,
  emailVerification,
  escapeHtml,
  frontendLink,
  passwordReset,
} from '../../src/infrastructure/mail/mail.templates.js';

const config = {
  frontendOrigin: 'https://app.nelio.test',
  mail: { from: 'Nelio <no-reply@nelio.test>' },
} as AppConfig;

interface Sent {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}
function capturingTransport() {
  const sent: Sent[] = [];
  const transport = {
    sendMail: jest.fn((message: Sent) => {
      sent.push(message);
      return Promise.resolve({ accepted: [message.to] });
    }),
  };
  return {
    sent,
    transport: transport as unknown as Transporter,
    sendMail: transport.sendMail,
  };
}

describe('templates', () => {
  const token = 'tok_en+with/odd=chars&more';

  it('frontendLink builds a link under the frontend origin and URL-encodes the token', () => {
    const link = frontendLink(
      'https://app.nelio.test/',
      '/verify-email',
      token,
    );
    const url = new URL(link);
    expect(url.origin).toBe('https://app.nelio.test');
    expect(url.pathname).toBe('/verify-email');
    expect(url.searchParams.get('token')).toBe(token); // round-trips
    expect(link).not.toContain('&more'); // the & inside the token is encoded, not a new parameter
    expect(frontendLink('https://app.nelio.test', '/login')).toBe(
      'https://app.nelio.test/login',
    );
  });

  it('escapeHtml escapes the five characters that matter', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;',
    );
  });

  it('the verification email has a subject, a text body and an HTML body with the link and the validity', () => {
    const url = frontendLink('https://app.nelio.test', '/verify-email', token);
    const mail = emailVerification({
      fullName: 'Ani Hakobyan',
      url,
      validForHours: 24,
    });
    expect(mail.subject).toBe('Confirm your email address for Nelio');
    expect(mail.text).toContain(url);
    expect(mail.text).toContain('Hi Ani Hakobyan');
    expect(mail.text).toContain('24 hours');
    expect(mail.html).toContain('<!doctype html>');
    expect(mail.html).toContain(escapeHtml(url));
  });

  it('the reset email says one hour in the singular and links to the reset page', () => {
    const url = frontendLink(
      'https://app.nelio.test',
      '/reset-password',
      token,
    );
    const mail = passwordReset({ fullName: 'Ani', url, validForHours: 1 });
    expect(mail.subject).toBe('Reset your Nelio password');
    expect(mail.text).toContain('1 hour and');
    expect(mail.text).toContain(url);
    expect(mail.text).toContain('your password stays as it is');
  });

  it('the "already registered" email carries no token, only the login and forgot-password pages', () => {
    const mail = alreadyRegistered({
      fullName: 'Ani',
      loginUrl: 'https://app.nelio.test/login',
      forgotPasswordUrl: 'https://app.nelio.test/forgot-password',
    });
    expect(mail.subject).toBe('You already have a Nelio account');
    expect(mail.text).toContain('https://app.nelio.test/login');
    expect(mail.text).toContain('https://app.nelio.test/forgot-password');
    expect(mail.text + mail.html).not.toMatch(/token=/);
  });

  it('a hostile name cannot inject markup into the HTML body, and control characters are removed', () => {
    const mail = emailVerification({
      fullName: '<script>alert(1)</script>\r\nBcc: attacker@evil.test',
      url: 'https://app.nelio.test/verify-email?token=x',
      validForHours: 24,
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.text.split('\n')[0]).not.toContain('\r');
    expect(mail.text.split('\n')[0]).toBe(
      'Hi <script>alert(1)</script>  Bcc: attacker@evil.test,',
    ); // plain text keeps the characters, line breaks become spaces
  });

  it('a blank name falls back to "there"; Armenian and right-to-left names are kept', () => {
    const url = 'https://app.nelio.test/x';
    expect(
      emailVerification({ fullName: '   ', url, validForHours: 24 }).text,
    ).toContain('Hi there,');
    expect(
      emailVerification({ fullName: 'Անի Հակոբյան', url, validForHours: 24 })
        .text,
    ).toContain('Hi Անի Հակոբյան,');
    expect(
      emailVerification({ fullName: 'علي', url, validForHours: 24 }).html,
    ).toContain('علي');
  });
});

describe('MailService', () => {
  let errors: unknown[];
  let warnings: unknown[];
  beforeEach(() => {
    errors = [];
    warnings = [];
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message: unknown) => void errors.push(message));
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((message: unknown) => void warnings.push(message));
  });
  afterEach(() => jest.restoreAllMocks());

  const token = 'SECRET-TOKEN-1234567890';
  const address = 'private.person@example.test';

  it('sends the verification email from the configured sender to the recipient, with the link', async () => {
    const { sent, transport } = capturingTransport();
    const service = new MailService(transport, config);
    expect(
      await service.sendEmailVerification(address, {
        fullName: 'Ani',
        token,
        validForHours: 24,
      }),
    ).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: 'Nelio <no-reply@nelio.test>',
      to: address,
      subject: 'Confirm your email address for Nelio',
    });
    expect(sent[0].text).toContain(
      `https://app.nelio.test/verify-email?token=${token}`,
    );
    expect(sent[0].html).toContain('verify-email?token=');
  });

  it('sends the reset and the already-registered emails', async () => {
    const { sent, transport } = capturingTransport();
    const service = new MailService(transport, config);
    expect(
      await service.sendPasswordReset(address, {
        fullName: 'Ani',
        token,
        validForHours: 1,
      }),
    ).toBe(true);
    expect(
      await service.sendAlreadyRegistered(address, { fullName: 'Ani' }),
    ).toBe(true);
    expect(sent.map((m) => m.subject)).toEqual([
      'Reset your Nelio password',
      'You already have a Nelio account',
    ]);
    expect(sent[0].text).toContain('/reset-password?token=');
    expect(sent[1].text).toContain('https://app.nelio.test/login');
  });

  it.each([
    [
      'a header-injection attempt',
      'victim@example.test\r\nBcc: attacker@evil.test',
    ],
    ['two addresses', 'a@example.test, b@example.test'],
    ['an address with a display name', 'Name <a@example.test>'],
    ['no @', 'not-an-address'],
    ['an empty string', ''],
    ['spaces', 'a b@example.test'],
  ])(
    'refuses %s as a recipient: not sent, no throw, and the address is not logged',
    async (_label, to) => {
      const { transport, sendMail } = capturingTransport();
      const service = new MailService(transport, config);
      expect(
        await service.sendPasswordReset(to, {
          fullName: 'Ani',
          token,
          validForHours: 1,
        }),
      ).toBe(false);
      expect(sendMail).not.toHaveBeenCalled();
      expect(JSON.stringify(warnings)).not.toContain(
        to.slice(0, 5) === 'victi' ? 'victim' : to || 'x-never',
      );
      expect(warnings).toEqual([
        {
          event: 'mail_not_sent',
          template: 'PASSWORD_RESET',
          reason: 'invalid_recipient',
        },
      ]);
    },
  );

  describe('a failing mail server never breaks the caller', () => {
    it('an asynchronous failure resolves to false', async () => {
      const transport = {
        sendMail: () =>
          Promise.reject(
            Object.assign(new Error(`connect ECONNREFUSED to ${address}`), {
              code: 'ECONNREFUSED',
            }),
          ),
      } as unknown as Transporter;
      const service = new MailService(transport, config);
      await expect(
        service.sendEmailVerification(address, {
          fullName: 'Ani',
          token,
          validForHours: 24,
        }),
      ).resolves.toBe(false);
    });

    it('a synchronous throw from the transport resolves to false as well', async () => {
      const transport = {
        sendMail: () => {
          throw new Error('boom');
        },
      } as unknown as Transporter;
      const service = new MailService(transport, config);
      await expect(
        service.sendAlreadyRegistered(address, { fullName: 'Ani' }),
      ).resolves.toBe(false);
    });

    it('an SMTP rejection (for example 550) resolves to false and logs the template and the codes only', async () => {
      const transport = {
        sendMail: () =>
          Promise.reject(
            Object.assign(new Error(`550 mailbox ${address} unavailable`), {
              code: 'EENVELOPE',
              responseCode: 550,
              command: 'RCPT TO',
            }),
          ),
      } as unknown as Transporter;
      const service = new MailService(transport, config);
      expect(
        await service.sendEmailVerification(address, {
          fullName: 'Ani',
          token,
          validForHours: 24,
        }),
      ).toBe(false);
      expect(errors).toEqual([
        {
          event: 'mail_send_failed',
          template: 'EMAIL_VERIFICATION',
          code: 'EENVELOPE',
          responseCode: 550,
          command: 'RCPT TO',
        },
      ]);
    });

    it('the log contains neither the address, nor the token, nor the link, nor the error message', async () => {
      const transport = {
        sendMail: () =>
          Promise.reject(
            Object.assign(new Error(`failed for ${address} with ${token}`), {
              code: 'ESOCKET',
            }),
          ),
      } as unknown as Transporter;
      const service = new MailService(transport, config);
      await service.sendEmailVerification(address, {
        fullName: 'Ani Private',
        token,
        validForHours: 24,
      });
      const logged = JSON.stringify(errors) + JSON.stringify(warnings);
      expect(logged).not.toContain(address);
      expect(logged).not.toContain(token);
      expect(logged).not.toContain('verify-email');
      expect(logged).not.toContain('Ani Private');
      expect(logged).not.toContain('failed for');
    });

    it('a server that never answers is given up on after the deadline, not waited for', async () => {
      jest.useFakeTimers();
      try {
        const transport = {
          sendMail: () => new Promise(() => undefined),
        } as unknown as Transporter; // never settles
        const service = new MailService(transport, config);
        const result = service.sendPasswordReset(address, {
          fullName: 'Ani',
          token,
          validForHours: 1,
        });
        await jest.advanceTimersByTimeAsync(MAIL_SEND_DEADLINE_MS - 1);
        let settled = false;
        void result.then(() => (settled = true));
        await Promise.resolve();
        expect(settled).toBe(false); // still waiting just before the deadline
        await jest.advanceTimersByTimeAsync(2);
        await expect(result).resolves.toBe(false);
        expect(errors).toEqual([
          expect.objectContaining({
            event: 'mail_send_failed',
            code: 'ETIMEDOUT',
          }),
        ]);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
