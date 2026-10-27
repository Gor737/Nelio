import { Module } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { APP_CONFIG, type AppConfig } from '../config/index.js';
import { MAIL_TRANSPORT, MailService } from './mail.service.js';

/** How long the application waits for the mail server before it gives up (the email is then reported as not sent). */
const SMTP_TIMEOUT_MS = 10_000;

/**
 * Mail infrastructure. In development the transport talks to Mailpit (docker-compose: SMTP on 1025, inbox on http://localhost:8025);
 * in production it uses the SMTP_* settings and requires TLS. Only the Auth module imports it (dependency rule).
 */
@Module({
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        nodemailer.createTransport({
          host: config.mail.host,
          port: config.mail.port,
          secure: config.mail.secure,
          requireTLS: config.nodeEnv === 'production' && !config.mail.secure,
          auth:
            config.mail.user !== undefined
              ? { user: config.mail.user, pass: config.mail.password }
              : undefined,
          connectionTimeout: SMTP_TIMEOUT_MS,
          greetingTimeout: SMTP_TIMEOUT_MS,
          socketTimeout: SMTP_TIMEOUT_MS,
        }),
    },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
