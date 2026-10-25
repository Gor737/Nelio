import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Transporter } from 'nodemailer';
import { APP_CONFIG, type AppConfig } from '../config/index.js';
import {
  alreadyRegistered,
  emailVerification,
  frontendLink,
  passwordReset,
  type RenderedEmail,
} from './mail.templates.js';

/** Injection token of the nodemailer transport; tests replace it with a capturing or a failing one. */
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export type MailTemplateName =
  'EMAIL_VERIFICATION' | 'PASSWORD_RESET' | 'ALREADY_REGISTERED';

/**
 * The longest a request waits for the mail server in total. The transport has its own connection, greeting and socket timeouts;
 * this is the backstop for a server that keeps the conversation going but never finishes, so a registration never hangs on mail.
 */
export const MAIL_SEND_DEADLINE_MS = 15_000;

/** One address, no display name tricks and no line breaks (a CR or LF in a header value is header injection). */
const RECIPIENT = /^[^\s<>@,;]+@[^\s<>@,;]+$/;

/**
 * Sends the three authentication emails (docs/architecture.md section 11). The contract that matters:
 *
 *   - **It never throws.** A mail server that is down, slow or refusing must not turn a registration or a password reset into a
 *     500: the endpoints answer 202 whatever happens (they must not reveal whether an address exists). Every method resolves to
 *     `true` (accepted by the mail server) or `false` (not sent), and the failure is logged.
 *   - **Never call it inside a database transaction** (Decision 159: no network inside transactions). The caller commits first.
 *   - **The log never contains the recipient address, the link or the token.** It names the template and the SMTP error code only.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: Transporter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  sendEmailVerification(
    to: string,
    input: { fullName: string; token: string; validForHours: number },
  ): Promise<boolean> {
    return this.deliver('EMAIL_VERIFICATION', to, () =>
      emailVerification({
        fullName: input.fullName,
        validForHours: input.validForHours,
        url: frontendLink(
          this.config.frontendOrigin,
          '/verify-email',
          input.token,
        ),
      }),
    );
  }

  sendPasswordReset(
    to: string,
    input: { fullName: string; token: string; validForHours: number },
  ): Promise<boolean> {
    return this.deliver('PASSWORD_RESET', to, () =>
      passwordReset({
        fullName: input.fullName,
        validForHours: input.validForHours,
        url: frontendLink(
          this.config.frontendOrigin,
          '/reset-password',
          input.token,
        ),
      }),
    );
  }

  sendAlreadyRegistered(
    to: string,
    input: { fullName: string },
  ): Promise<boolean> {
    return this.deliver('ALREADY_REGISTERED', to, () =>
      alreadyRegistered({
        fullName: input.fullName,
        loginUrl: frontendLink(this.config.frontendOrigin, '/login'),
        forgotPasswordUrl: frontendLink(
          this.config.frontendOrigin,
          '/forgot-password',
        ),
      }),
    );
  }

  private async deliver(
    template: MailTemplateName,
    to: string,
    render: () => RenderedEmail,
  ): Promise<boolean> {
    try {
      if (!RECIPIENT.test(to)) {
        this.logger.warn({
          event: 'mail_not_sent',
          template,
          reason: 'invalid_recipient',
        });
        return false;
      }
      const { subject, text, html } = render();
      await withDeadline(
        this.transport.sendMail({
          from: this.config.mail.from,
          to,
          subject,
          text,
          html,
        }),
        MAIL_SEND_DEADLINE_MS,
      );
      return true;
    } catch (error) {
      const failure = error as {
        code?: unknown;
        responseCode?: unknown;
        command?: unknown;
      };
      this.logger.error({
        event: 'mail_send_failed',
        template,
        code: typeof failure.code === 'string' ? failure.code : undefined,
        responseCode:
          typeof failure.responseCode === 'number'
            ? failure.responseCode
            : undefined,
        command:
          typeof failure.command === 'string' ? failure.command : undefined,
      });
      return false;
    }
  }
}

/** Rejects with a `ETIMEDOUT` error when `promise` has not settled within `ms`; the timer never keeps the process alive. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error('mail send deadline exceeded'), {
            code: 'ETIMEDOUT',
          }),
        ),
      ms,
    );
    timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
